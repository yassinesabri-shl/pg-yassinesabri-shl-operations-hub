# Harness maturity scorecard — scoring worksheet

Programme / estate: ______________________________   Date: ____________

Scored by (two people who disagree): ______________________________________

Repository open during scoring?  [ ] yes   [ ] no  ← if no, stop. The score will be fiction.

**Rules of the instrument**

1. A level is met when you can point at the artefact, file or observable behaviour. Not when
   you can describe the intention.
2. Between two levels? Score the **lower** one. The instrument's value is that it does not
   round up.
3. Score with engineers and the repository. Not with the sponsor in the room.
4. Governance and control are **gates, not contributors**. See the cap rule below.

---

## 1. Context — do agents reliably know what is true?

- [ ] **0** No repository file governs agent behaviour. Context arrives by paste.
- [ ] **1** One instruction file in the repository, auto-loaded by at least one runtime. Last
      substantive edit predates the last agent-caused incident.
- [ ] **2** Constitution states the source-of-truth order **and its tie-breaker**. Path-scoped
      always-on rules imported by path from the constitution, path-scoped rules on a named read
      list. Companion file for any second runtime. Reference corpus cached
      locally with a navigation index.
- [ ] **3** Context budget explicit per agent and measured. Constitution commit history shows
      rules added after named incidents. Artefacts carry provenance to source section and line.
      Every design names the repository rules it was written under, at a commit, and the gate
      reads the line. Sampled citation check runs.
- [ ] **4** Context has a named owner and review cadence. Hash of constitution + rules + skills
      recorded per run. A rules pull request triggers evaluation of affected agents before merge.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## 2. Agents — is work produced and judged by different things?

- [ ] **0** One general-purpose session. No named roles.
- [ ] **1** Named agents exist as prompt snippets in chat or a wiki. No charter files in the repo.
- [ ] **2** Every agent is a charter file with a one-line purpose and an explicit "never does".
      Producer and judge are separate agents; the critic runs on fresh context as a structural
      property of the runtime. Model tier assigned per role, in writing.
- [ ] **3** Revision caps declared per artefact type with a named escalation route on cap.
      Critics read-only w.r.t. the artefact — enforced, or the gap documented with compensating
      controls. The roster has been deliberately **reduced** at least once.
- [ ] **4** Cross-provider review where risk justifies it. Every charter has a matching active
      registry entry, checked in CI **in both directions**. Agent count has a written rationale.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## 3. Control — can a machine decide whether work may advance?

- [ ] **0** Human review at merge is the only check.
- [ ] **1** CI runs lint and tests. No coverage floor. Nothing gates work entering the loop.
- [ ] **2** Coverage floor, static types, secret scanning — all blocking. A written definition of
      ready that a human applies.
- [ ] **3** Readiness contract is machine-readable: fixed fields, pure tokens, integrity
      cross-check that overrides the author's own verdict. An executable gate reads it and has
      its own fixture suite. The gate distinguishes *fail* from *cannot verify* and refuses to
      judge on stale state. State machine names the owner of every transition.
- [ ] **4** Every agent-owned transition has a mechanical predicate. Irreversibility controls
      (merged-migration immutability and equivalents) machine-enforced. Human gate count per work
      item equals the declared number, and a sample of last month's merges confirms it.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## 4. Governance — would this survive somebody asking to see it?

- [ ] **0** No written policy on agent use. No trail beyond version control.
- [ ] **1** Policy exists as a memo or slide. No repository artefact enforces it. Agents hold
      whatever permissions the runtime grants by default.
- [ ] **2** Deny-by-default declared for every side-effecting action; an undefined control
      resolves to the most restrictive reading. Clarification log with a blocking flag and a
      named human route per row. Review verdicts committed beside the artefacts they judge.
- [ ] **3** Highest-risk scope enforced in the **tool layer** — a write outside the sanctioned
      zone throws in the code path, not the prompt. Human-in-the-loop decision map written with
      owner, trigger, expected response time and a **fail-closed** fallback per row. Data
      handling classified per agent. Standing audit questions answerable from repository
      artefacts within a day.
- [ ] **4** Remaining enforcement gaps recorded **as gaps** in the artefacts an auditor reads,
      each with compensating controls named. Decision map reviewed against a sample of real
      merges. Every control traces to the incident that produced it.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## 5. Fleet operations — do you know what you are running, and whether it still works?

- [ ] **0** Nobody can say how many agents are running.
- [ ] **1** A hand-maintained list exists somewhere. It drifts. No per-agent cost attribution.
- [ ] **2** Registry file schema-validated in CI: owner, model, scope, review date and a
      revocation path per agent — who may suspend it, what happens to work in flight, how fast
      the stop propagates. Structured run logs exist and name the agent.
- [ ] **3** Dispatch gated on registration — an unregistered or non-active agent cannot run. One
      structured record per worker-critic round with a machine-derived quality measure. Cost
      attributed per agent and per work item. Scheduled evaluation including a frozen set that
      is never edited.
- [ ] **4** Four metrics with alert conditions and named owners: case-set pass rate,
      recovery-rate trend, escalation rate, cost per accepted artefact. A quarterly review that
      has actually retired an agent. Audit attestation generated from the registry, not written.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## 6. Knowledge compounding — does the second engagement start ahead of the first?

- [ ] **0** Each project starts from nothing. Lessons live in the people who were there.
- [ ] **1** A README plus tribal knowledge. The second project re-derives the first's rules.
- [ ] **2** Constitution and rule pack are free of client identifiers and have been reused on a
      second workstream. Reasoning depth extracted into skill files loaded by more than one agent.
- [ ] **3** Analysis-phase knowledge persists into build through a shared artefact that does not
      reset at the phase boundary. Each engagement leaves scaffolding the next starts from, and
      the setup tax is measured rather than estimated.
- [ ] **4** Reuse is instrumented: you can state the throughput difference between a first and a
      subsequent engagement from your own data. Retired agents' evidence retained and searchable.
      The accelerator library adopted by a second team without its authors present.

**Level: ___**   Evidence pointed at: _______________________________________________

---

## Scoring

```
  Dimension              Weight    Level (0-4)    Points = (level / 4) x weight
  ---------------------  ------    -----------    ----------------------------
  Context                   15         ____                  ______
  Agents                    15         ____                  ______
  Control                   20         ____                  ______
  Governance                25         ____                  ______
  Fleet operations          15         ____                  ______
  Knowledge compounding     10         ____                  ______
  ---------------------  ------                   ----------------------------
  WEIGHTED SCORE           100                              ______ / 100
```

**Now apply the cap.** Governance and control are gates, not contributors.

```
  min(Control level, Governance level) = ____

     0 or 1  ->  band cannot exceed  ASSISTED
          2  ->  band cannot exceed  GOVERNED PILOT
          3  ->  band cannot exceed  GOVERNED AT SCALE
          4  ->  no cap

  WEIGHTED BAND: ____________________
  BAND CAP:      ____________________
  FINAL BAND (the lower of the two): ____________________
```

| Score | Band | Next move — one thing, not five |
|---|---|---|
| 0–24 | Experimenting | Write the constitution for **one** workstream, including the source-of-truth tie-breaker |
| 25–44 | Assisted | Build the machine-readable readiness contract, then the executable gate that reads it |
| 45–64 | Governed pilot | Stand up the registry and the first evaluation case file. Then take the constitution to a second workstream |
| 65–84 | Governed at scale | Automate what is manual: cost per accepted artefact per agent, scheduled frozen-set evaluation, a quarterly review that retires something |
| 85–100 | Compounding | Extend the lifecycle, not the harness. Publish the accelerators and let a team you have never met adopt them |

---

## The six questions — ask these of any score of 65 or above

Answer with an artefact or a demonstration. "Our policy is that…" is a failure.

| # | Question | Attacks | Pass? | What was actually shown |
|---|---|---|---|---|
| 1 | Show me the enforcement. Pick one agent's "cannot" list and show the line of code or config that throws | Governance | [ ] | |
| 2 | Show me the last time a gate blocked something, and what happened next | Control | [ ] | |
| 3 | Open the constitution's commit log. Which incident does each of the last three changes close? | Context | [ ] | |
| 4 | Enumerate your active agents now, from a file, without asking anyone | Fleet ops | [ ] | |
| 5 | Show me cost per accepted artefact for last month, decomposed by agent | Fleet ops | [ ] | |
| 6 | Take an artefact accepted last week and trace it to the signed source, by section and line | Context / governance | [ ] | |

Any question failed on a dimension you scored 3 or 4 → **reduce that dimension by one level and
re-score.** Then re-apply the cap.

---

## What the final band permits

| Band | Autonomy rung supported, per loop | Operate tier supported |
|---|---|---|
| Experimenting | Assistive only. A human authors, an agent accelerates | None |
| Assisted | **A1 supervised execution** — the agent produces, a human reviews the edits, reversible work only | Tier 0 — read-only situation report |
| Governed pilot | **A2 supervised release, one loop** — agents own every mechanically verifiable transition; humans approve transitions, not edits (specification merge, pull-request merge) | Tier 1 — pre-approved runbook execution |
| Governed at scale | **A2 across multiple loops** — autonomy expanded per class of work, against evidence, never globally | Tier 2 — ticket to fix to deploy, under validation |
| Compounding | **A3 autonomous within declared bounds** — where the correctness oracle is deterministic and the envelope is signed | Tier 3 remains a north star. Not a 2026 conversation |

Tier 2 requires **level-3 fleet operations** as a precondition. Operational work has no test
suite as its correctness oracle, so evaluation, drift detection, registry and cost attribution
have to be real first.

---

## Action plan out of this score

Lowest-scoring dimension: ______________________  (this is the only one worth funding this quarter)

One thing you will build in the next 30 days: ____________________________________________

The artefact that will prove it: ________________________________________________________

Who owns it (role): _____________________________________________________________________

Re-score date (90 days): ________________  Expect at least one dimension to go **down**. That is
the instrument working, not the programme failing.

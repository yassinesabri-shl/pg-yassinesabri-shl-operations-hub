---
name: context-budget
description: Explicit window allocation, read order, and the subagent return contract.
globs: ["**/*"]
alwaysApply: true
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-09-01 -->

# Rule — the context budget

The context window is a **budget with an allocation**, not a container you fill until it
stops accepting input. Any knowledge an agent cannot access in-context effectively does
not exist — and any knowledge that crowds out the constraints is worse than absent,
because it displaces the governance rules that were loaded first.

## Allocation

Assume a working window of `200,000` tokens. Allocate it:

| Allocation | Share | Contents |
|---|---|---|
| Constitution and matched rules | ~5% | always-on governance |
| Task frame | ~10% | the work item, its design, its acceptance criteria |
| Working set | ~50% | the files actually being read and changed |
| Subagent returns | ~15% | distilled summaries only |
| Headroom | ~20% | unallocated, deliberately |

**Never plan to fill the window.** An agent at 95% utilisation degrades in a specific and
dangerous way: it starts dropping the earliest-loaded material, which is the constitution.
The failure is silent and it removes the governance first.

If a task will not fit the allocation, that is a decomposition signal. Split the task; do
not compress the constraints.

## The global layer

A hub with a global context repository reads two parts of it in every run of every product.
Each part has a cap:

| Part | Cap | What counts |
|---|---|---|
| The always-on bodies | 8 KB (8,192 bytes), about 2,000 tokens | the body of every binding global document with `alwaysApply: true`, as `scripts/read-context.mjs` prints it |
| The index | 16 KB (16,384 bytes), about 4,000 tokens | every global index line, as `scripts/read-context.mjs` prints it. A superseded record, a Reserved standard and a withdrawn exception leave the index |

`scripts/check-context.mjs --global` refuses a commit over either cap. The global repository's
required check, `global-gate`, runs it on every pull request. The two caps together take about
6,000 tokens of the constitution's 5% share on a 200,000-token window. They are first
estimates, and a later library release can change them after they are measured.

To stay under a cap, give a document globs in place of `alwaysApply: true`, shorten its
description, or supersede a record that no longer binds.

## Read order — cheapest first, stop early

1. **Cache, index or digest.** A local cache of the corpus, an index keyed by identifier,
   a pre-digested requirements list. Read this first, always.
2. **Locate, then read narrowly.** Search with `grep` or `find` to find the relevant location.
   Read by line offset around it. Search before read is a rule, not a preference.
3. **Full file read** — only when the file is the unit of work.
4. **Live remote calls** — reserved for **writes** and for freshness-sensitive reads. Never
   for exploration.

**Never read in bulk.** Do not hand an agent a three-hundred-page document per task.
Index it once; look up by identifier thereafter. Bulk reading is the most common cause of
both token blow-up and latency complaints, and it is entirely avoidable.

The economics are not marginal, and the mechanism is what carries them: a local
cache-first read order removes almost all exploratory retrieval traffic, and indexing a
large requirements corpus converts a document scan into an identifier lookup — on every
task, for the life of the programme.

## The orchestration layer is not the work layer

> The main session is the orchestration layer; subagents do the work.

The main session's job is to dispatch, collect, and decide. It does not read the corpus,
does not hold the working set, and does not accumulate the transcript of every subtask it
delegated. Use subagents liberally — the cost of a subagent is far lower than the cost of
an orchestrator that has lost its own instructions.

Concretely, in the main session:

- Read the work item, its design, and this repository's rules.
- Dispatch each unit of investigation or production to a subagent.
- Receive summaries. Decide. Move state.
- Do **not** open the files a subagent is already reading in order to "check".

## The subagent return contract

Every subagent returns a **distilled summary**, not its raw context. Target under 2,000
tokens. The shape:

    ## Result
    <one paragraph: what was done or found>

    ## Evidence
    - <file>:<line> — <the specific fact, quoted minimally>

    ## Open
    - <anything unresolved, with the specific question>

    ## Confidence
    confirmed | derived | assumption | contradiction

Rules:

- **No transcripts.** A subagent never returns its reasoning trace or the content of the
  files it read.
- **Evidence is located.** A claim without a file and line is not evidence.
- **Contradictions are returned immediately**, not summarised into a resolution. A
  subagent that resolves a contradiction silently has destroyed the most valuable thing
  it found.
- If a summary cannot be made to fit, the subagent's task was too broad. Return that fact.

## Compaction discipline

For long-running sessions, compact deliberately rather than letting the runtime do it at
the worst moment. When compacting, preserve, in this order: the constitution reference,
the decisions taken and why, open questions and blockers, the current working set. Discard
exploratory reading, superseded plans, and resolved findings.

Write the compaction summary to a durable location — a shared knowledge board or the work
item — not just into the next prompt. Knowledge that lives only in a window is knowledge
you will pay to rediscover.

## Prohibited

- Loading an entire corpus, document or dataset "to have it available".
- Using live remote read calls for exploration when a cache exists.
- An orchestrator performing production work in the main session.
- A subagent returning raw file contents or its reasoning trace.
- Planning any task to exceed the allocation above.
- Silently resolving a contradiction found by a subagent.

## Charter size — the drift guard

A charter is a contract, not a manual. Every agent charter is **20–60 lines** and never
restates the content of the skill it loads: the charter carries identity, prohibitions,
the verdict or output contract, and the pointer to the method — the method itself lives in
the skill, once. Two files carrying the same procedure is a pair that drifts, and in a prior
delivery of this pattern the drift was only resolved by deleting the duplicated wrappers
wholesale; the policy here encodes that lesson without taking the one-way door.

Config is language; code is control. `scripts/check-charters.mjs` installs with this rule and
fails the build on any charter over **80 lines** (`*.template.md` exempt — a template carries
the exemplar a seat is instantiated from, so it is longer than the seat it produces). Wire it
into CI over `.claude/agents/` in the same change that installs it; a policy with no job behind
it is prompt-level and belongs in the constitution's §12 self-audit table instead.

When a charter presses against the cap, move method to the skill or the command — never
compress the prohibitions.

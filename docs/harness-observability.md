<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-26 -->

# Observability

The harness records what each harness command uses, and sends the records to the hub's observability
platform, CubeAPM or Grafana. This version of the library records the tokens of every model call
that a harness command makes, and their cost. It sends one record for each seat and each turn of the
main session, and the observability platform totals the records for each story and each feature. The
harness also records work time: when each agent worked, when a run waited for the person, and each
command's elapsed time. It records when the harness fails. Observability is not optional. Every
harness command but `/connect-observability-platform` refuses to start until the hub is connected
(§4).

## 1. What a record holds, and what it never holds

A record holds counts, keys and ids, and the person who ran the command:

- **who the cost belongs to:** `story`, `feature`, `command`, `run_id` and `agent`. `agent` is the
  seat, or `orchestrator` for the main session. Every subagent that the runtime ships, such as
  Claude Code's `Explore`, is `runtime-agent`, and the record's `runtime` names the runtime. Any
  other subagent is `other-agent`, so that no name from a person's settings leaves the laptop.
- **who ran the command,** in `person`. It is the login of the GitHub account that `gh` is signed
  in to on the laptop. When `gh` is missing or signed out, it is `user.email` from git in the hub's
  main checkout. It is lowercase. With neither, it is empty. A run takes its person when it opens,
  and every record of the run carries that person, the seats' records too.
- **the Jira links,** where the hub records them: `ticket_url`, the story's ticket, and `epic` and
  `epic_url`, the feature's Epic (below).
- **its bucket,** in `scope`:
  - `story`: the record has a story.
  - `feature`: the record has a feature and no story, as the records of `/feature` and `/decompose`
    do.
  - `estate`: the command carries no key, such as `/add-repo` or `/connect-observability-platform`.
  - `none`: a story or feature command found no key.
- **where the key came from,** in `key_from`: `command`, `branch`, `work` or `next-command` (§2).
  It is empty when the record has no key.
- **what the observability platform totals:** five token counts and `cost_usd`, at list price
- **where it came from:** the runtime and its version, and the collector adapter

A record never holds a prompt, a command argument other than a key or a slug, a file path, a
file's content, a tool's input or output, or the assistant's text. `person` holds only a GitHub
login or an e-mail address, never a free-text name. Its only URLs are the Jira links, each in the
one shape `https://<site>/browse/<JIRA-KEY>`. The collector refuses any record that breaks this
rule before it reaches the queue, and the sender refuses it before it leaves.

`person` is personal data: it leaves the laptop and stays on the observability platform for as long
as the platform keeps records.

A record's `type` says what it holds. A `tokens` record holds the token counts and the cost above.
Three more types hold work time, from the times in each runtime's own log (§5):

- `work`: one turn of the main session, or one activation of a seat. It holds `agent`,
  `started_at`, `ended_at` and `duration_s`, and its model time and tool time, `model_s` and
  `tool_s`.
- `wait-in-session`: one wait for the person inside a run, with its `gate`: `reply`, `question` or
  `permission-prompt`. `gate_wait_s` is the part of it that a `gate` record counts: when a gate
  merged during the wait, the time from the wait's start to that merge.
- `command`: one harness command's elapsed time, from its prompt to the end of its last turn or
  seat. A question that the person declines ends the turn with no work after it, so its wait ends
  the command. It holds `busy_s`, the time when at least one agent worked, `wait_s`, the time when
  the run waited for the person, `gate_wait_s`, the part of its waits that a `gate` record counts,
  and `unexplained_s`, the rest. The four parts add up to `duration_s`. It also holds the run's
  pickup: `previous_gate`, the human gate that the command follows, `previous_gate_merged_at`, that
  gate's last merge before the command started, and `pickup_s`, the time between. The pickup is
  recorded only. It is not human wait time.

One more type holds the human gates:

- `gate`: one merge of a human gate, which the hub's `observability-gates` workflow writes at the
  merge (§2). A laptop never writes it. It holds the `gate`, `routed_to`, the role that the gate
  goes to, the `repository` where it merged and its `pull_request` number. Its times are
  `opened_at`, `handoff_at`, the pull request's last commit, `started_at` and `merged_at`, and
  `gate_s` is the gate wait, from `started_at` to `merged_at`. It has no command, no run and no
  person, because a person's merge is no harness command. Its `key_from` is `pull-request`. It
  carries the Jira links as the other records do, from the hub's trunk at the merge.

A work-time record carries the same keys and the same bucket as a tokens record, and no tokens and
no price. Its times are clock times in UTC, and its durations are seconds.

One more type holds the harness's failures:

- `failure`: one failure of the harness, with its `source`:
  - `script`: a harness script exited 2 (cannot verify), 3 (usage) or 4 (internal). `check` names
    the script, `exit_code` the code, and `outcome` says `cannot-verify`, `usage` or `internal`. Its
    times run from the call to its result. Exit 1 is not a failure: the check worked and refused the
    work. A harness script writes its own last line on exit 2, 3 or 4, `HARNESS EXIT: <script>
    <code>`, and the record takes the code from that line when it is there. Agents usually pipe a
    script into `tail` or `head`, or follow it with `; echo`, and either hides the code of the shell
    call itself.
  - `runtime`: the runtime failed a turn, at `started_at`. `outcome` is `runtime`.

  `reason` is a short token where the harness knows the cause: the runtime's type of error, such as
  `server_error`, or the token of a script's last `REASON:` line, such as `remote-unreachable`. A
  script's token must be on the fixed list in `scripts/spoke-remote.mjs` (`REASONS`), so a record
  never carries the sentence the script printed for the person, with its URLs and paths. Only a
  script on the harness's fixed list counts, and the record names it, never the command line.

The sender fills the Jira links from the hub's trunk (§2):

- `ticket_url`: the story's ticket.
  - A story of `/decompose` takes the ticket from the link file of its decomposition,
    `docs/estate/tracker-links/<SLUG>.json`, on the site that `docs/estate/trackers.json` gives
    the ticket's instance.
  - A story that `/from-ticket` took in takes the host of its snapshot's `Source:` line, and its own
    key, which is the Jira key. The line's path, query and fragment never leave the laptop.
- `epic` and `epic_url`: the Jira key and the URL of the feature's Epic, from the feature's link
  file. A story that `/from-ticket` took in has no Epic.

Each field is empty when the hub records no ticket: a hub with no Jira connection, a record with no
story or no feature, or a link file that the laptop's copy of the trunk does not hold yet (§8). The
work on a defect names its story's ticket. A view opens the ticket from `ticket_url`. A report joins
the records with Jira's own by the key at the end of the URL: a story of `/decompose` has a harness
key, such as `PROJ-12`, and a different Jira key, such as `PLAT-345`.

Each record names its form in `schema`. The six types share one form, `harness-observability/1`.

## 2. How it works

1. **A harness command opens a run.** When a person types `/dev-sprint PROJ-102`, the hook notes
   that this runtime session works on PROJ-102, and who runs it (§1). The hook waits for `gh` 2
   seconds at most, and keeps its answer in `person.json`. A login stays there for 24 hours. An
   empty answer stays for 1 hour, so while `gh` fails, the hook asks it again once an hour.
2. **The run takes its key from the first of four sources,** which `key_from` names:
   - `command`: the command line. `/decompose` takes its slug from its document's path.
   - `branch`: the branch of the session's working folder. `/feature` takes its slug from
     `requirements/<SLUG>` when it creates that branch, and a story command takes its key from
     `feature/<KEY>-…`.
   - `work`: a harness script that the run's work starts with a story's key. The five scripts are
     `check-dev-ready.js`, `check-validation.js`, `check-design-amend.mjs`, `jira-sync.mjs apply`
     and `test-guard.mjs setup --key`. A seat's work counts too.
   - `next-command`: the same story command, typed again with its key in the same session, with no
     other harness command between. The run before it, which had no key, takes that key, when it
     started at most 10 minutes earlier.

   A key, once found, never changes. Work on another story ends the run, and opens a run for that
   story from that moment. A feature command and an estate command never take a key from the work.
3. **Every model call joins that run.** Follow-up prompts, seats and other subagents join it too,
   until the next harness command. A session where nobody typed a harness command sends nothing.
4. **When a seat or a turn finishes, the hook reads the runtime's own log of the calls.** It counts
   what is new since the last read, and writes one record for each run, model and price tier to a
   local queue. Then it starts the sender in the background. It never waits for the network.
5. **The sender adds the story's feature,** from `docs/backlog/<SLUG>/<KEY>.item.md` on the hub's
   trunk, the Jira links from the same trunk (§1), the record's bucket, and the price. It sends the records to the observability platform,
   and keeps any that the observability platform did not accept. A record that a hook queues while a
   sender runs leaves with that sender. The sender collects the queue again after each send, three
   times at most.
6. **Each read also takes the work time** from the same log. In Claude Code's transcripts, it reads
   each prompt line, each model call's request and answer lines, each tool result and each turn's
   end line. A turn's record waits for the turn's end line. A seat's record waits for its handback,
   its next resume, the next read after it stops, or the session's end. At the end of a turn, the hook
   writes the command record of each ended run whose turns and seats have all finished. The same read
   finds the harness's failures: a shell call of a harness script whose result carries exit 2, 3 or
   4, and a line that says the runtime failed the turn. A failure belongs to the run that holds it.
7. **The sender adds a command's pickup.** It reads the hub's trunk, as this clone last fetched it,
   for the last merge before the command's start of the gate that the command follows. The
   commands fetch the trunk when they start. With no such merge, or a trunk that git cannot read,
   the three pickup fields are empty, and nobody asks again.

   | Command | Follows | Key of the gate |
   |---|---|---|
   | `/decompose` | `requirements-merge` | feature |
   | `/dev-spec` | `decomposition-merge` | the story's feature |
   | `/dev-sprint` | `design-merge` | story |

   Every other command follows no gate. When one merge has two runs after it, both carry a pickup
   from that merge, and the smaller one is the real pickup (§9). The same read gives
   `gate_wait_s`: a hub gate that merged while the run waited for the person.
8. **The hub's `observability-gates` workflow writes the gate records,** one for each merge of a
   human gate, at the merge, and sends them with the hub's own secret (`generation.md` §5 of the
   library, and `docs/estate/observability.json` for the connection):
   - A hub pull request that merged gives one record for each gate whose file it changed.
   - A story's code merge happens in the spoke. The spoke's `story-gate` workflow then starts the
     hub's workflow, with the pull request's number, and the hub reads that merge from the spoke's
     API.
   - The gate wait starts at the hand-off: the later of the pull request's opening and its last
     commit. A story's code merge waits from no earlier than its validation report's merge, because
     the spoke's `qa-gate` holds the code merge until then.

   | Gate | What merges | Key | `routed_to` |
   |---|---|---|---|
   | `requirements-merge` | `docs/requirements/<SLUG>/requirements.md` | feature | `feature-owner` |
   | `decomposition-merge` | `docs/backlog/<SLUG>/` | feature | none yet |
   | `design-merge` | `docs/designs/<KEY>.lld.md` | story | none yet |
   | `validation-merge` | `docs/designs/<KEY>.validation.md` | story | none yet |
   | `story-merge` | the story's code, in the spoke | story | none yet |

A missed hook loses nothing: the next read carries the calls that it missed. A call that a resume or
a fork copies into another log counts once. Delivery is at least once. A duplicate can happen only
when the observability platform accepted a record and its answer was lost. The record's id lets a
query find the duplicate.

## 3. Where the state lives

Each hub clone keeps its state in one folder, `.harness/observability/`, at the root of the hub's
main checkout. Git must ignore it. The install adds `.harness/` to the hub's `.gitignore`, and the
collector writes nothing until `git check-ignore` confirms it. Every worktree of the hub shares the
folder. It holds no secret and no content:

| Path | Holds |
|---|---|
| `runs/` | the runs of each runtime session |
| `checkpoints/` | for each log, the counts already sent for each call |
| `index/` | the log that first counted each call id |
| `time/` | for each log, how far its work time was read, and its turn or activation still open |
| `time/runs/` | for each run, its finished work and waits, and the logs that hold a piece of it open |
| `queue/` | the records waiting to be sent |
| `sent/` | the records the observability platform accepted, kept for 30 days |
| `refused/` | the records the observability platform refused, with its answer |
| `send-state.json` | the failed sends in a row, the reason for the last one, and the time of the next try |
| `person.json` | the login that `gh` gave, or none, and when the hook asked. It asks again after 24 hours, or after 1 hour when `gh` gave none |
| `observability.log` | warnings and errors |

A fresh clone or `git clean -fdx` deletes the folder. The records not yet sent are then lost, and
nothing is counted twice.

## 4. Connect a hub

The hub install asks for the connection and writes it in the install pull request. A hub that has
no connection refuses every harness command but `/connect-observability-platform`, with the reason
and the fix. That happens to a hub installed before observability was required, and to a hub whose
`docs/estate/observability.json` is broken. A harness command also refuses to start when git does
not ignore `.harness/`, and with `bearer` when the session has no write token (step 2).

1. **Run `/connect-observability-platform`** in the hub, on a clean checkout of the trunk, to
   connect a hub that has no connection, or to change it. It asks four questions: the
   observability platform, its URL, whether its receiver needs a write token, and the hub's id. It
   writes `docs/estate/observability.json` and opens the pull request, which a person merges. No
   command removes the file. The file holds no credential:

   ```json
   {
     "schema_version": 1,
     "hub": "example-hub",
     "platform": "cubeapm",
     "url": "https://cubeapm.example.invalid",
     "auth": "bearer"
   }
   ```

   `platform` is `cubeapm` or `grafana`. The URL is the observability platform's own base URL, over
   `https`. For `grafana`, it is the base URL of the Loki collector, or of the proxy in front of the
   collector that checks the write token. `governance/observability.schema.json` gives the shape. A
   live run confirmed the CubeAPM adapter (§9). The Grafana adapter has no live run yet.

   `auth` says how the sender authorises its requests. `bearer` sends each laptop's write token in
   the Authorization header, and it is the default when the field is missing. `none` sends no
   authorisation, for a receiver that needs no key. With `none`, the sender never sends the token,
   even when it is set.
2. **With `bearer`, set the write token on each laptop,** in the environment variable
   `HARNESS_OBSERVABILITY_TOKEN`. Never put it in a file of the repository. With `none`, skip this
   step. Without the token, a harness command refuses to start: set the token, then start a new
   session. Records that a session queued before stay in the queue, and the sender writes a WARN
   line to `observability.log`, once a day while they wait.
3. **Check the connection:** `node scripts/observability-status.mjs`.

The platform does not need to answer for a harness command to start. A laptop that is offline, or
whose observability platform does not answer, keeps its records in the queue and sends them later.
When a record has waited more than 24 hours, Claude Code and Codex show a warning at the end of a
turn, once in each session that runs a harness command.

**Behind a TLS inspection proxy,** which re-signs HTTPS with its own authority, Node refuses the
connection unless it also trusts the operating system's certificates. The hook starts the sender
with `NODE_USE_SYSTEM_CA=1` for that, and certificate checks stay on. A person who runs the sender
by hand sets it too: `NODE_USE_SYSTEM_CA=1 node scripts/observability-send.mjs`.

UNRESOLVED — how each laptop reaches the observability platform, and how it gets and renews its
write token. Owner: risk owner, with the client. Resolves: before the first laptop sends a record.

UNRESOLVED — how long the observability platform keeps the records: CubeAPM's `logs.retention`, 24
hours by default, and Loki's retention for Grafana. Owner: the client's CubeAPM administrator, with
the risk owner. Resolves: before the pilot hub sends records.

## 5. The runtimes

| Runtime | How the harness hears of it | What it reads | Status |
|---|---|---|---|
| Claude Code | hooks in `.claude/settings.json`: `UserPromptSubmit`, `PreToolUse` on `Bash`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd` | each agent's transcript | confirmed by a live run on 2.1.308 |
| Codex | hooks in `.codex/hooks.json`: `UserPromptSubmit`, `PreToolUse` on `Bash`, `Stop`, `SubagentStop`, `SessionEnd` | each thread's rollout file | built from Codex's source, untested |
| OpenCode | the plugin `.opencode/plugin/harness-observability.js`: a command's start, a `bash` call that starts one of the five scripts (§2), and each idle session | each session's `step-finish` parts, through OpenCode's own client | built for v1.19.4, no live run yet |

How each runtime refuses a harness command (§4):

| Runtime | How | Status |
|---|---|---|
| Claude Code | the `UserPromptSubmit` hook answers `{"decision":"block","reason":…}`. Claude Code shows the reason, and no model call starts | confirmed by a live run on 2.1.316 |
| Codex | the same answer to its `UserPromptSubmit` hook | built from Codex's source, untested |
| OpenCode | the plugin waits for the hook at `command.execute.before`, 10 s at most, and throws the reason. OpenCode then stops the command before its prompt | built for v1.19.4, no live run yet |

The `PreToolUse` hook runs at every `Bash` call. It ends at once when the call starts none of the
five scripts. In a test on 2026-10-29, such a call took 30 ms, and Node's own start took 22 ms.

Claude Code runs a project's hooks only after a person trusts the folder. Open the hub in Claude
Code once and accept its trust dialog. Codex also asks a person to trust a project's hooks before it
runs them. In Codex, a harness command starts as `/prompts:<name>`, `/<name>` or `$<name>`.

Each runtime's log format is internal to that runtime and can change in any release. A hub cannot
hold its runtimes at one version, because they update themselves. A live run on Claude Code 2.1.308
confirmed the Claude Code adapter. No live run has confirmed the Codex and OpenCode adapters yet.

Each runtime has its own time reader. Live runs on Claude Code 2.1.308 confirmed the Claude Code
reader on 2026-10-31. The runs were interactive sessions of `/dev-spec`, `/dev-sprint` and
`/qa-sprint`, with the merges between them, and print-mode runs of `/estate-overview`. No live run
has confirmed the Codex and OpenCode readers yet:

| Runtime | Collector | What it reads for work time |
|---|---|---|
| Claude Code | `claude-code-time/1` | each transcript's prompt lines, request and answer lines, tool results and turn ends, as Claude Code 2.1.308 writes them. A print-mode session (`claude -p`) writes its prompt with `turnOrigin: "sdk"` and no `origin`, and ends a turn with `stop_hook_summary` alone |
| Codex | `codex-time/1` | each rollout's turn start and end lines, tool calls and their outputs, and each response's token record, from Codex's source at `970111f` |
| OpenCode | `opencode-time/1` | each message's times and each tool call's start and end, which the plugin passes, and the plugin's own times of each permission request and reply, for v1.19.4 |

Codex and OpenCode read a seat only at its stop, so that read finishes the seat's work.

Each runtime's time reader also reads its failures. A live run on Claude Code 2.1.316 confirmed the
Claude Code failure reader in the main session on 2026-11-09. No live run has confirmed the Codex
and OpenCode failure readers yet:

| Runtime | Collector | What it reads for failures |
|---|---|---|
| Claude Code | `claude-code-failures/1` | a `Bash` call's result with `is_error` whose text starts `Exit code <n>`, or whose output has the script's `HARNESS EXIT:` line, and a line with `isApiErrorMessage`, whose `error` is the type |
| Codex | `codex-failures/1` | an `exec_command` call's output with the line `Process exited with code <n>`, or with the script's `HARNESS EXIT:` line, and a `turn_complete` whose `error` carries `codex_error_info`, from Codex's source at `970111f` |
| OpenCode | `opencode-failures/1` | a `bash` call's `metadata.exit`, the codes of its output's `HARNESS EXIT:` lines and its `REASON:` token, and an assistant message's `error.name`, which the plugin passes, for v1.19.4. `MessageAbortedError` is a person's abort, and is not a failure |

## 6. Prices

`scripts/observability/prices.json` holds the list prices, in USD per million tokens, from each
provider's price page, with the page and the date it was read. The cost is API-equivalent: a bill
for API-key users, and a comparison on subscriptions. Every rate is stored as its own number.

| Provider in a record | Rows |
|---|---|
| `anthropic` | Anthropic's API: every Claude model on its price page |
| `foundry` | Claude in Microsoft Foundry, which bills at Anthropic's rates, so it reads the `anthropic` rows |
| `openai` | OpenAI's API, the Standard tier: the GPT, o-series and Codex models on its price page, except the Pro models |
| `google` | Google's Gemini API, the paid Standard tier, for text input |

A model is found by its exact id, then by its id without a date suffix such as `-20251001` or
`-2025-04-14`, never by a shorter prefix. A model with no row gets no cost, never a guessed one. A
row with no cache-write rate prices a cache write at its input rate, as OpenAI and Google bill one.
A price change reaches the hub through a library upgrade.

## 7. Commands

- `node scripts/observability-status.mjs`: the queue, its oldest record, the refusals, the last
  send, how the hub authorises its requests, and the person that a new run's records name, from
  `gh` asked now or from git. It warns when records name no person: run `gh auth login`, or set
  `git config user.email`. Exit 0 when nothing needs a person. Exit 1 when the
  observability platform refused records, or a record has waited more than 7 days. Exit 2 when the
  hub is not connected, or git does not ignore the state folder. A hub in that state refuses every
  harness command but `/connect-observability-platform`.
- `node scripts/observability-send.mjs`: send what is ready now. The hook already starts it after
  each record. Exit 0 when everything ready was sent, 1 when the observability platform refused
  records, and 2 when nothing could be sent. A web page in answer, even with a 200, means the URL
  leads to a web interface and not to the receiver. The records then stay in the queue, and
  `observability-status.mjs` names the last failure. A 401, 403 or 404, or CubeAPM's 400 for a path
  it does not serve, means a wrong key or URL, so the records stay in the queue too. A failed
  connection names its cause, such as `ECONNREFUSED`.

## 8. Known limits

- **One person can show under two values.** A laptop where `gh` is signed in gives the login, and a
  laptop where it is not gives the git address. A view per person then splits that person's totals.
- **`person` says who the laptop claims to be.** Anyone can set any address in git. A record is not
  a proof of who worked.
- **A run keeps the person it opened with.** A change of the `gh` account or of git's address
  reaches the next run, or the next day when the login came from `person.json`.
- **A forked session, or a resumed one under a new id, sends nothing** until a person types a
  harness command in it. Its copied calls are skipped, so nothing counts twice.
- **`/pr-review` finds its story only in the story's worktree,** from the branch `feature/<KEY>-…`.
- **A record sent before its link file reached the laptop has no Jira links.** The sender reads the
  trunk as the laptop last fetched it. It never fetches and never holds a record for a ticket.
  Every story command runs `check-dev-ready.js`, which fetches the trunk, so most of a story's
  records carry the URL. A sent record never changes. A per-story view shows the records with no
  URL in a row with an empty `ticket_url` (§9).
- **A ticket that moves keeps its old URL in the records sent before.** A per-story view then shows
  one row for each URL.
- **A change of story with no harness command and no harness script stays on the first story.** A
  run moves to another story only when its work starts one of the five scripts with that story's
  key (§2).
- **Claude Code makes calls that no transcript holds, so no record counts them:**
  - A compaction's own model call. In a test, it was 7% of one session's cost.
  - One call after each turn, on the session's model, for the suggested next prompt.
  - One call on Haiku, for the session's title.
  - Calls on the model that the answer lines name in `advisorModel`. In a playground test on
    2026-10-31, one story's records equalled its transcripts for Opus to the token. Claude Code counted
    12.3% more Opus cost: 8.2 million cache reads, 154,586 input tokens and 2,524 output tokens.

  Only Claude Code's own totals count them. In the closed sessions of a playground test, the first
  three came to 11.5% of what Claude Code counted.
- **A record carries a cost only for a provider in the table (§6).** Amazon Bedrock and Google Cloud
  set their own prices for Claude and Gemini, and their price pages give them only to a browser, so
  their records carry no cost yet. Azure OpenAI and every other provider have no rows either.
- **Some rates are not used.** A record does not say whether a call used OpenAI's Fast, Flex or
  Batch tier, or Anthropic's US-only inference, so each is priced at the standard rate. A 12-hour
  OpenAI cache write is priced at the 30-minute rate, because Codex reports one write count.
  Google's audio input costs more than text, and its context-cache storage is billed by the hour,
  and neither is counted.
- **Codex keeps no approval request in its rollout,** so its records hold no permission wait.
  Codex also writes no line when a request starts. So a response starts at the line before it: the
  turn's start, the last tool output or the last response.
- **OpenCode has no session end.** The command record of a session's last command waits for the next
  command in that session.
- **The hub's workflow runs on SHL's internal runner**, `[self-hosted, linux, ecs-novadev]`, in a hub
  that `SHL-India` owns. That runner reaches the internal CubeAPM. GitHub gives an organisation's
  runner only to that organisation's repositories, so a hub with another owner runs on
  `ubuntu-latest` instead of waiting in the queue. There, an internal platform cannot be reached:
  the send ends with exit 2 and a warning. A hub with its platform on another network changes
  `runs-on` in its installed workflow to a runner that reaches its platform.
- **A gate record that could not be sent is not sent again by itself.** The workflow warns and
  stays green. A person runs it again by hand with the pull request's number.
- **A merge made with `GITHUB_TOKEN` starts no workflow,** because GitHub does not run a workflow
  for an event that its own token caused. A person's merge, and a person's auto-merge, start it.
- **A spoke whose signal fails gives no gate record of its story's merge.** The spoke's job fails
  on the merged pull request. A person starts the hub's workflow by hand with the spoke's id and
  the pull request's number.
- **A spoke whose hub token cannot start the hub's workflows sends no signal,** so the hub has no
  record of its story merges. The token is the one that `HUB_TOKEN_SECRET` in the spoke's
  `checks.env` names, and it needs "Actions: write" on the hub.
- **A pickup needs the trunk that this clone fetched.** A command whose clone had not fetched the
  merge has no pickup. Most commands fetch the trunk when they start.
- **A code merge inside a reply wait stays in `wait_s` too.** The laptop reads only the hub's trunk,
  so it removes only a hub gate's merge from the waits.
- **A story of `/from-ticket` has no decomposition merge,** so its `/dev-spec` has no pickup.
- **Time spent between two runs with no merge is in no record,** such as a blocking clarification,
  or the time between `/decompose` and a story's first `/dev-spec`.
- **Four gates name no role yet.** UNRESOLVED — the roles that merge the decomposition, design, story
  and validation pull requests. Owner: harness lead. Resolves: the commands that open those pull
  requests name the role.
- **A permission prompt's wait also holds the tool's own run.** The transcript keeps the time of the
  call and of its result, but not the moment when a person allowed it. So the span stays inside the
  turn's tool time too, and the command counts it as busy.
- **A session whose working folder disappears loses the project's hooks,** and Claude Code gives no
  error. The closing `/qa-sprint` removes `.worktrees/<KEY>/`, so it stops when the session runs
  inside that folder, and it names the hub's root. Any other removal has the same effect: nothing is
  recorded from that moment.
- **A seat that a later run resumes keeps its cost in the run of its first call.** Its work time
  goes to the run that resumed it.
- **A prompt that Claude Code submits again on a schedule opens a new run each time.** A
  `ScheduleWakeup` with a harness command as its prompt turned one typed command into three runs.
- **A harness command pasted with a long argument can open no run.** Claude Code hands a long paste
  to the hook as pasted content, and the hook does not read it as a command. In a test on
  2026-10-31, an argument of about 900 characters did this.
- **A session that stops with no `SessionEnd` hook** leaves its last turn unsent when that turn has
  no end line. The command record of its last run waits too.
- **Some failures of a harness script give no record:**
  - A command line that names two or more harness scripts. The exit code is the line's, not one
    script's.
  - A shell line that hides the script's exit code and also loses the script's `HARNESS EXIT:`
    line. Two forms do: `2>&1` into a filter that drops the last line, such as `head`, `grep`,
    `awk` or `sed`, and output sent to a file or to `/dev/null`. A pipe alone, `; echo` and
    `|| true` keep the line, because it goes to stderr and the pipe carries stdout only.
  - A script that Node stops before its exit handler runs, such as one killed by a signal.
  - A harness script that runs in a session where nobody typed a harness command, because such a
    session sends nothing (§2).
  - On Codex, a process that still runs when `exec_command` returns. Its exit code comes later, in
    a `write_stdin` output, which this reader does not read.
- **A reason comes only from the script.** Every harness script names a token from the list when it
  cannot verify. A failure with no `REASON:` line carries no `reason`: exit 3 and exit 4, a runtime
  failure that names no type of error, and an exit 2 whose cause the script does not name. The
  script and the exit code still say where it failed.
- **A dated price change waits for an upgrade.** Google doubles gemini-4-argon's rates on
  2026-12-01, and gemini-3.8-flash's and gemini-3.6-flash's on 2027-01-01. Until a library upgrade
  brings the new rates, their records carry the old ones.

## 9. CubeAPM dashboard setup

A live run confirmed the CubeAPM adapter on 2026-10-28. CubeAPM accepted the records, kept each
field as its own field, and dropped the empty ones. Its sums per story, feature and seat matched
the records sent. CubeAPM does not keep a value sent as `env`, so a record carries its hub only in
its own `hub` field.

Each query picks the harness's records by `service.name`, and each kind of record by `type`. A
query with no `hub` filter totals every hub that sends to this CubeAPM. To show one hub, add
`hub:="<the hub's id>"` after the stream filter, as in
`{service.name="harness"} hub:="example-hub" type:=tokens`. A hub keeps its id when its repository
is created again, so the records of an earlier test with the same id stay in the platform. Set the
panel's time range to start after the last test that you do not want to see.

### The cost panels

- **The cost:**

  ```
  {service.name="harness"} type:=tokens | stats sum(cost_usd) as total
  ```

- **The cost per feature.** The `format` stage names the group with no feature:

  ```
  {service.name="harness"} type:=tokens | format if (feature:"") "no feature" as feature | stats by (feature) sum(cost_usd) as cost
  ```

- **The cost per story, with its ticket** (§1). A table panel shows text only as a label, so the
  ticket is a `by` field:

  ```
  {service.name="harness"} type:=tokens story:* | stats by (story, ticket_url) sum(cost_usd) as cost
  ```

  The table has one row for each story and URL. A story with records that left before its link
  file reached the laptop (§8) has one more row, with an empty `ticket_url`. A story whose ticket
  moved has one row for each URL, and a story with no ticket has one row with an empty `ticket_url`.

- **The cost per Epic.** The `format` stage names the group with no Epic:

  ```
  {service.name="harness"} type:=tokens | format if (epic:"") "no epic" as epic | stats by (epic, epic_url) sum(cost_usd) as cost
  ```

- **The cost per agent:** each seat, `orchestrator`, `runtime-agent` and `other-agent` (§1):

  ```
  {service.name="harness"} type:=tokens | stats by (agent) sum(cost_usd) as cost
  ```

- **The cost per model:**

  ```
  {service.name="harness"} type:=tokens | stats by (model) sum(cost_usd) as cost
  ```

- **The cost per person** (§1). The `format` stage names the group with no person:

  ```
  {service.name="harness"} type:=tokens | format if (person:"") "no person" as person | stats by (person) sum(cost_usd) as cost
  ```

- **The cost by bucket and by the source of the key** (§1), which shows how much cost has no story:

  ```
  {service.name="harness"} type:=tokens | stats by (scope, key_from) sum(cost_usd) as cost
  ```

- **The records with no price.** They carry no cost (§6), so no cost view shows them:

  ```
  {service.name="harness"} type:=tokens cost_usd:"" | stats by (model_provider, model) count() as records
  ```

### Building a panel

- **Choose Logs as the panel's source.** A Metrics source reads the query as PromQL, and fails with
  "unparsed data left" or "identExpr".
- **Set the panel's Value to sum.** A panel runs its query in buckets of time, and Value joins the
  buckets. With "average", the panel shows the average for each bucket once records spread over
  time.
- **Build every total in a dashboard panel.** The Logs search page adds `| sort (_time desc)` to the
  query, so a query that ends with `stats` does not work there.
- **A chart groups the bars beyond its limit into "Others".** "Others" is the sum of the bars that
  the chart does not draw.
- **Show a ticket as a label, in the one `stats` step of the panel.** On the client's instance on
  2026-11-11, a table panel showed the text field of a `stats` step, such as `max(ticket_url)`, as
  an empty cell. The panel reads each stats field as a number, and it takes its labels from `by`.
  A second `stats` step in the query made the panel show the rows of both steps, so each row
  appeared twice. Put the URL in `by (…)`, and keep one `stats` step with numbers only.
- **Name the group with no value.** A chart draws the records with no story as a bar with an empty
  name. A `format` stage before `stats` gives that bar a name, here "no story":

  ```
  {service.name="harness"} type:=tokens | format if (story:"") "no story" as story | stats by (story) sum(cost_usd) as cost
  ```

  Without `story:*`, this view keeps the records with no story, so its rows add up to the cost.
- **`story:*` excludes every record with no story,** so the sum of the stories is less than the
  cost. Three kinds of work have no story:

  - `/feature` and `/decompose`, which run before any story exists. Their records have a feature.
  - The commands with no key, such as `/add-repo`, `/connect-observability-platform` and
    `/survey-repo`.
  - A command for one story, when it finds no key: `/dev-spec`, `/dev-sprint` or `/qa-sprint`
    typed without one, or `/pr-review` outside the story's worktree (§8). The run takes the key
    later from the story's branch, from its work, or from the same command typed again (§2). Until
    then, its records are in the bucket `none`.

  The cost per feature counts all three, so the sum of its groups is the cost. The last two kinds
  have no feature either, so their records form one group with no feature.

A panel test on the client's instance confirmed the `format if` stage and the `cost_usd:""` filter
on 2026-10-29.

### The time panels

Seven of these panels were built on the client's instance on 2026-11-02, from the records of a
playground test. The panel by person is new, and no instance has run it yet. Each shows hours. The query divides the seconds by 3600, rounds to 0.01 and keeps
only the figures that the chart draws. Divide by 60 to show minutes. Three words need a definition:

- **Working time** is `busy_s` of the `command` records: the time when at least one agent worked.
  Seats that work at the same time count once.
- **Agent time** is `duration_s` of the `work` records. Two seats that work at the same time count
  twice, so agent time is more than working time. Only the `work` records name the agent.
- **Human wait time** is the time that the harness waits for a person. It is `wait_s` of the
  `command` records, the waits inside runs, plus `gate_s` of the `gate` records, the gate waits.
  A wait inside a run that a gate's merge also covers is in `gate_wait_s`, not in `wait_s`, so no
  second counts twice. The pickup after a merge, `pickup_s`, is not human wait time.

The panels:

- **Total harness working time (Hour):**

  ```
  {service.name="harness"} type:=command | stats sum(busy_s) as busy_s | math round(busy_s / 3600, 0.01) as busy_h | fields busy_h
  ```

- **Total human wait time (Hour).** One query adds the two parts:

  ```
  {service.name="harness"} type:in("command", "gate") | format if (type:="command") "<wait_s>" as human_s | format if (type:="gate") "<gate_s>" as human_s | stats sum(human_s) as human_s | math round(human_s / 3600, 0.01) as human_h | fields human_h
  ```

- **Harness work time by feature (Hour):**

  ```
  {service.name="harness"} type:=command | format if (feature:"") "no feature" as feature | stats by (feature) sum(busy_s) as busy_s | math round(busy_s / 3600, 0.01) as busy_h | fields feature, busy_h
  ```

- **Harness work time by story (Hour):**

  ```
  {service.name="harness"} type:=command story:* | stats by (story, ticket_url) sum(busy_s) as busy_s | math round(busy_s / 3600, 0.01) as busy_h | fields story, ticket_url, busy_h
  ```

- **Harness work time by person (Hour):**

  ```
  {service.name="harness"} type:=command | format if (person:"") "no person" as person | stats by (person) sum(busy_s) as busy_s | math round(busy_s / 3600, 0.01) as busy_h | fields person, busy_h
  ```

- **Time by type of agent (Hour).** It shows agent time, for each seat, `orchestrator`,
  `runtime-agent` and `other-agent`:

  ```
  {service.name="harness"} type:=work | stats by (agent) sum(duration_s) as agent_s | math round(agent_s / 3600, 0.01) as agent_h | fields agent, agent_h
  ```

- **Human wait by gate (Hour).** It shows the gate waits, for each merge gate and the role that it
  goes to:

  ```
  {service.name="harness"} type:=gate | stats by (gate, routed_to) sum(gate_s) as human_s | math round(human_s / 3600, 0.01) as human_h | fields gate, routed_to, human_h
  ```

- **Human wait within runs (Hour).** It shows the waits inside a run: a `reply`, a `question` and a
  `permission-prompt`:

  ```
  {service.name="harness"} type:="wait-in-session" | math duration_s - gate_wait_s as human_s | stats by (gate) sum(human_s) as human_s | math round(human_s / 3600, 0.01) as human_h | fields gate, human_h
  ```

  The part of a reply wait that a gate's merge also covers is in the gate panel, not here.

- **Stories done.** A `story-merge` record means that the story's code merged on its spoke's
  harness trunk, after its validation report merged. The query counts distinct stories, because a
  revert and a second code pull request give a second record. Done means merged, not deployed:

  ```
  {service.name="harness"} type:=gate gate:=story-merge | stats by (feature) count_uniq(story) as stories_done
  ```

- **Pickup after each gate (Hour).** The time from a gate's merge to the first command after it.
  Two runs after one merge both carry a pickup, so the query takes the smaller one for each key and
  gate. The pickup is not human wait time:

  ```
  {service.name="harness"} type:=command previous_gate:* | stats by (story, feature, previous_gate) min(pickup_s) as pickup_s | stats by (previous_gate) sum(pickup_s) as pickup_s | math round(pickup_s / 3600, 0.01) as pickup_h | fields previous_gate, pickup_h
  ```

The stories-done and pickup panels are new, and no instance has run them yet.

### The failure panels

UNRESOLVED — these queries have not run on the client's instance yet. Owner: harness lead. Resolves:
a panel test on the client's CubeAPM confirms `format if (…)` and `max` on a time field.

Each panel shows one hub, so each query names it after the stream filter.

- **Failures per story,** by where they came from:

  ```
  {service.name="harness"} hub:="example-hub" type:=failure | format if (story:"") "no story" as story | stats by (story, source, check, outcome) count() as failures
  ```

- **Failures by script.** It shows which harness script fails, and how:

  ```
  {service.name="harness"} hub:="example-hub" type:=failure source:=script | stats by (check, outcome, reason) count() as failures
  ```

- **Runtime failures by type:**

  ```
  {service.name="harness"} hub:="example-hub" type:=failure source:=runtime | stats by (reason, agent) count() as failures
  ```

- **The attention table: the failures of the last 7 days, per story:**

  ```
  {service.name="harness"} hub:="example-hub" type:=failure _time:7d | stats by (story, source, check, outcome, reason) count() as failures, max(ended_at) as last_at | sort by (last_at desc)
  ```

One alert rule covers what needs a person at once:

- **A harness failure of its own,** exit 3 or 4, over the last hour, with the condition above 0:

  ```
  {service.name="harness"} type:=failure outcome:in("usage", "internal") | stats count() as failures
  ```

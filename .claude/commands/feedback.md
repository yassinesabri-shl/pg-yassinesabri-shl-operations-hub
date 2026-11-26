---
description: Report feedback or a bug about the harness from inside a session. Asks for the text, whether it is a bug and whether it blocks you, shows the ticket, and creates it on the harness team's Jira board through the Atlassian MCP. Sends no prompt, no path and no file. Writes nothing to the hub.
argument-hint: [<free text>]
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-24 -->

# `/feedback [<free text>]`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and
the stopping condition. The write to Jira goes through the Atlassian MCP server in the runtime.
This command uses no credential of its own and holds none.

**Purpose.** Let any harness user report feedback or a bug, and have a ticket appear on the
harness team's board at once. A blocker lands where the team sees it first. Nothing is copied
from another system, and nothing is written to the hub.

**Who runs it.** A person types it in the hub, at any point in a session. It dispatches no seat.

## The target

The target is fixed in this file. The library's upgrade replaces this file when the target
changes.

| Fact | Value |
|---|---|
| Site | `shl.atlassian.net` |
| Project key | `PLDC` |
| Board | https://shl.atlassian.net/jira/software/c/projects/PLDC/boards/1151 |
| Issue type | `Feedback` |
| Label on every ticket | `harness-feedback` |
| Label on a bug | `harness-bug` |
| Label on a blocker | `harness-blocker` |
| Label for the active command | `cmd-<name>`, such as `cmd-dev-sprint`. Omitted when no command was active |
| Priority on a blocker | `Critical` |
| Priority otherwise | `Medium` |

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| `<free text>` | The feedback, in the person's words. Any length | The argument. Without one, proposed from the session in step 1, or asked |
| Bug | `yes` or `no` | Asked in step 2 |
| Blocker | `yes` or `no` | Asked in step 3 |
| Error output | Text the person pastes. Optional | Asked in step 4, only for a bug |
| Context | One JSON object | `node scripts/feedback-context.mjs`, run in the hub root |
| What happened | Three to six sentences in the agent's words | Written from this session in step 5 |

## Preconditions

Check both before the first question.

1. The Atlassian MCP server is installed and the person is signed in. Call the MCP tool
   `atlassianUserInfo`. A reply with an account is a pass. No such tool, or a failed call, is a
   stop. On a stop, print the setup steps below and end. Do not ask for a credential.
2. The working directory is the hub root. `scripts/feedback-context.mjs` is there.

Setup steps to print on a stop:

```
The Atlassian MCP server is not available in this session.
1. Run once, in a terminal:  claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp
2. Start Claude Code again and type /mcp. Follow the sign-in for "atlassian".
3. Run /feedback again.
```

## What it does

Ask one question at a time. Give lettered choices. Put the suggested answer first.

1. **The text.** Use the argument when it is given. Without one, read this session for the
   problem: a failed command, an error, a refusal, or a step the person pushed back on. When
   you find one, propose it in one or two sentences and ask: "Is this what you want to
   report?" (a) yes (b) no, I will describe it. On `b`, or when the session shows no problem,
   ask: "What do you want to report?" The proposal is in your words. Do not quote the session.
2. **Bug or not.** Ask: "Is this a bug?" (a) no (b) yes.
3. **Blocker or not.** Ask: "Does this block your work?" (a) no (b) yes.
4. **Error output.** Only when step 2 is `yes`. Ask: "Paste the error output, or type skip."
5. **The context.** Run `node scripts/feedback-context.mjs` and keep its output. Do not change
   it. Do not add to it. Then write "What happened" from this session: which command or skill
   was running, what the agent did, and what the result was. Three to six sentences, in your own
   words. Name the active command, if there was one, for the `cmd-<name>` label. Do not copy a
   prompt, a path, a file's contents or a diff into it. Say "No command was running" when the
   person typed `/feedback` with nothing before it.
6. **Show the ticket.** Build the summary and the description as the next section says. Show
   both in full, with the labels. Ask: "Create this ticket?" (a) yes (b) edit "What happened"
   (c) remove "What happened" (d) no. On `b`, take the person's text and show the ticket
   again. On `c`, drop the section and the `cmd-<name>` label and show the ticket again. On
   `d`, end. Nothing is created.
7. **Create the ticket.** Call the MCP tool `createJiraIssue` with the project key, the issue
   type, the summary, the description, the labels and the priority from the table above. The
   person's own MCP sign-in is the reporter.
8. **Report.** Print the ticket key and its URL, `https://shl.atlassian.net/browse/<KEY>`. End.

## The ticket

**Summary.** `[Harness] ` followed by the first line of the text, cut at 80 characters.

**Description.** Five parts, in this order.

```
<the text, word for word>

Bug: <yes|no>
Blocks the reporter: <yes|no>

What happened
<three to six sentences from step 5, or the person's edit of them>

Context
| Harness version | <harnessVersion or "unknown"> |
| Library commit | <libraryCommit or "unknown"> |
| Runtime | <runtime or "unknown"> |
| Node | <node> |
| OS | <os.platform> <os.release> |
| Hub | <hub or "unknown"> |
| Collected on | <collectedOn> |

Error output
<the paste, in a code block. Omit this part when there is no paste>
```

## What the ticket never carries

- A prompt, from the person or from the harness.
- A file path, including the hub's folder.
- A file's contents, a diff or a commit.
- An environment variable, a token or a key.
- Anything the person did not see in step 6.

The context script prints no path by design. "What happened" is a summary in the agent's words,
never a copy of the session. If the error paste or the summary contains a path, say so in step 6
and ask the person to remove it or to confirm it.

## Stopping condition

Done when the ticket exists and its key is printed. Not done, and nothing created, when a
precondition fails or the person answers `no` in step 6.

## Never

- Never ask for, accept or write a token, a password or a key.
- Never create a ticket the person has not seen in full.
- Never quote the session. Summarise it.
- Never write a file in the hub. This command leaves no trace in the repository.
- Never change the target in a session. A different board is a change to this file.

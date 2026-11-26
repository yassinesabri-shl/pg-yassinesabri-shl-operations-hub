---
description: Connect the hub to its observability platform — ask for the observability platform, its URL, whether its receiver needs a write token, and the hub's id, write docs/estate/observability.json, and open the pull request that records it. Every other harness command waits for this connection. Holds no credential. Merges nothing.
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-27 -->

# `/connect-observability-platform`

**This file is a contract, not an integration.** It defines the procedure, the preconditions and the
stopping condition. The code host and the pull-request mechanism are yours. In this version the
command writes only one file, and `scripts/observability-status.mjs` proves that file well formed.

**Purpose.** Tell the hub which observability platform receives its records, in one file,
`docs/estate/observability.json`. The observability platform is CubeAPM or Grafana, and it totals
the records for each story and each feature. Observability is not optional. In a hub with no such
file, every other harness command refuses to start and names this command. This command always
starts. Run it once to connect, and again to change the observability platform, its URL, or
whether its receiver needs a write token. Only this command and the hub install write the file. No
command removes it.

**It holds no credential.** When the observability platform's receiver needs a write token, each
laptop keeps its own in the environment variable `HARNESS_OBSERVABILITY_TOKEN`. The file names the
observability platform, its URL, the hub's id and how the sender authorises its requests, and
nothing else.

## Inputs

| Input | Form | Where it comes from |
|---|---|---|
| The observability platform | `cubeapm` or `grafana` | Asked |
| The URL | The observability platform's own base URL, `https://…`, with no user name and no password | Asked |
| Whether the receiver needs a write token | Yes, the default (`bearer`), or no (`"auth": "none"`) | Asked |
| The hub's id | Letters, digits, `.`, `_` and `-`, starting with a letter or a digit, at most 100 | Asked, with the name of the hub's repository as the suggestion |
| `docs/estate/observability.json` | The connection, against `governance/observability.schema.json` | This command creates it on the first run and edits it after |
| `scripts/observability-status.mjs` | The check, run before the pull request opens | Installed with the hub |

## Preconditions

1. The working directory is the hub root, on a clean checkout of the trunk. This command cuts its
   own branch.
2. Git ignores `.harness/`: `git check-ignore -q .harness/observability/probe` exits 0. If it does
   not, add the line `.harness/` to `.gitignore` in the same pull request.
3. Nothing the person types is a credential. Refuse a URL that holds a user name or a password,
   where the person types it. Do not repeat the URL in the refusal.

## What it does

Ask one question at a time, lettered choices, the suggestion first, as the install interview
does. Where the file already holds an answer, offer it as the suggestion.

1. **The observability platform.** Offer two choices:
   - a) **CubeAPM**, which takes the records as JSON lines
   - b) **Grafana**, which takes them through its Loki collector

   Never choose the observability platform for the team. "Later" is not an answer: the hub's other
   harness commands do not start until the connection merges. When the person cannot answer yet,
   stop and write nothing.
2. **The URL.** The answer is the observability platform's own base URL. For CubeAPM, it is the base
   URL of its JSON-lines endpoint. For Grafana, it is the base URL of its Loki collector, or of the
   proxy in front of it that checks the write token.
3. **The write token.** Ask: "Does the observability platform's receiver need a write token?"
   - a) **yes**, the default: each laptop sends its own, from `HARNESS_OBSERVABILITY_TOKEN`
   - b) **no**: the receiver takes records without one

   Never ask for the token itself.
4. **The hub's id.** Suggest the name of the hub's repository: the last part of the path that
   `git remote get-url origin` prints, without `.git`. Every laptop sends the same id, and each
   record carries it.
5. **Write the file,** with these five fields and no other:

   ```json
   {
     "schema_version": 1,
     "hub": "<the hub's id>",
     "platform": "<cubeapm or grafana>",
     "url": "<the URL>",
     "auth": "<bearer or none>"
   }
   ```

   `auth` is `bearer` for a) of step 3: each laptop then sets its own write token. It is `none`
   for b).

```bash
git checkout -b estate/connect-observability-platform
node scripts/observability-status.mjs                 # its first line names the hub, the observability platform and the URL
git add docs/estate/observability.json .gitignore
node scripts/harness-commit.mjs -m "chore(estate): connect the hub to <cubeapm or grafana>"
# open the pull request in the hub, its description ending with the watermark line
```

The pull request carries one file, or two with `.gitignore`. Say in its description which
observability platform the person chose, and that the file holds no credential. Then tell the person
four things:

1. When the hub uses `bearer`, each person sets `HARNESS_OBSERVABILITY_TOKEN` on their own laptop,
   and never in a file. With `"auth": "none"`, nobody sets it.
2. The other harness commands start after the merge, once a laptop's checkout of the hub holds the
   file. A laptop then starts to collect.
3. `node scripts/observability-status.mjs` shows the connection on each laptop.
4. Every record names the person who ran the command: the login that `gh` is signed in to, or else
   `user.email` from git. The status command shows which one a laptop sends.

## Stopping condition

Done when the pull request is open, and `observability-status.mjs` on the branch printed a first
line that names this hub, the observability platform and the URL. Not done, and nothing opened, when
a precondition fails or the person cannot answer a question yet. Exit 2 from the check names the
field to correct: ask that question again.

## Never

- Never ask for, accept or write a token, a password or a key.
- Never write a URL with a user name or a password in it.
- Never edit `docs/estate/observability.json` by hand, and never copy
  `governance/observability.example.json` in.
- Never delete `docs/estate/observability.json`. Observability is not optional.
- Never merge the pull request. A merge is a person's act.

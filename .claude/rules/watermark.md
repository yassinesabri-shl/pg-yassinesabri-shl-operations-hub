---
name: watermark
description: The harness watermark — the line that visibly marks every commit and pull request the harness makes, how it is written, and how it is checked.
globs: ["scripts/harness-commit.mjs", "scripts/check-watermark.mjs", "scripts/check-staged.mjs", ".github/workflows/**", ".githooks/**"]
alwaysApply: false
paths: ["scripts/harness-commit.mjs", "scripts/check-watermark.mjs", "scripts/check-staged.mjs", ".github/workflows/**", ".githooks/**"]
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-01 -->

# Rule — the harness watermark

Every commit the installed harness makes in a hub or a spoke, every pull request it opens there,
and every review, comment and reply it posts on one, ends with this exact line:

```
Generated-by: SHL Agentic Harness
```

The watermark visibly tells harness-generated work from a person's. It is enforced by a local
commit check and by the pull-request gates. It is a label, not cryptographic proof: anyone can
type it, and a person's commit without it is simply a person's commit.

**Where it applies.** Hub and spoke repositories the harness is installed into — the commands,
the installation and the upgrade listed below. The `shl-harness` library repository, where the
harness is developed, is not watermarked: its own commits and pull requests are ordinary, and its
CI tests the installed behaviour in throwaway repositories without reading the library's own
history.

## The form

The watermark is the **final non-empty line**, written exactly: case-sensitive, no leading or
trailing space, nothing added — no Markdown, quote, list marker or code formatting — not inside a
code block or an HTML comment, and only once. It is a git trailer, the last line of the message's
trailer block: it stands in the final paragraph alone, or directly under other trailers, so
`Co-authored-by` and `Signed-off-by` trailers before it stay trailers that git and the code host
read, and so do the `Harness-Check:` lines the helper writes in a spoke, one per commit check. A watermark written under prose is not a trailer and fails. It names no agent and no tool. A
person's commits and pull requests are not changed.

## Commits

Every commit the installed harness makes is made with
`scripts/harness-commit.mjs -m <subject> [-m <paragraph>]...`,
never by `git commit` directly. It appends the watermark as the last trailer, with
`git interpret-trailers` — into the final paragraph when that is already a trailer block,
otherwise as a final paragraph of its own — checks the whole
message before git is asked to commit, and commits with the person's own git name, email and
signing configuration untouched. A spoke checkout is committed in with the hub's copy:
`node <HUB>/scripts/harness-commit.mjs --repo . -m ...`. The paths that commit: `/feature`,
`/decompose`, `/dev-spec`, `/dev-sprint`, `/qa-sprint`, `/survey-repo`, `/add-repo`,
`/add-context`, `/check-global --connect`, the hub and spoke installation, and the hub and spoke upgrade
(`scripts/upgrade.mjs`).

**The local check.** `/dev-spec` installs a `commit-msg` hook in the hub checkout it makes, and
`/dev-sprint` installs one in the code checkout it makes, after its config sync
(`harness-commit.mjs --install-hook`). A harness-managed commit — one made by
the helper, or one whose message carries the watermark phrase anywhere — is refused before it is
created when the watermark is missing or malformed. Its comment lines and scissors section are
dropped before the check and the message file is rewritten to the checked text, so whatever cleanup
mode git then applies, the watermark it approved is the line git stores last; for the same reason
the helper refuses a message line that starts with git's comment character. Every other commit is a
person's and passes untouched.

The hook does not replace the checkout's own hooks: every hook is handed on to the hooks folder in
force at install (`core.hooksPath`, or `.git/hooks`), so pre-commit, pre-push, husky or lefthook
keep running, and the checkout's own `commit-msg` runs after the watermark check. If something later
points `core.hooksPath` elsewhere (a husky install, for example), the hook stops running and the
helper says so on its next commit; the helper still checks its own messages. The hook is per
checkout and `git commit --no-verify` skips it; the pull-request gate catches what it missed. In
`/dev-sprint`'s code loop the engineer's commits never leave its clone: the protected-test guard's
finalizer (`scripts/test-guard.mjs`) commits the one that does, from the engineer's tree,
through this helper, so a commit made with `--no-verify` there carries nothing forward.

## Pull requests

Every pull request the harness opens ends its description with the same line, after the normal
description, as a final paragraph of its own.

**Reviews, comments and replies** on a pull request end with it too, as a final paragraph of their
own. The harness posts them only through `scripts/pull-request.mjs` — `/dev-sprint` steps 10a and
10b — which adds the watermark to every body itself and refuses one that already claims it, so
the line appears once. No gate reads comments: the script is the one way they are written, and the
check.

## The gate

`scripts/check-watermark.mjs --pr-body <file> <base>..<head>` runs as a step in the required
checks every pull request already runs — `design-gate` in the hub, `story-gate` in each spoke. It
reads every non-merge commit of the pull request, and the description from the pull-request
event, never from a file in the branch. Both gates also run when a description is edited, and the
step runs even when an earlier step of the same check failed, so one run lists every finding. The
spoke runs the hub trunk's checker, and stops with exit 2 (cannot verify) while the hub's trunk does
not carry it yet; the hub runs the base commit's checker, or the pull request's own copy only when
that pull request is the one bringing it.

1. a commit carries the watermark → the description must end with it;
2. the description carries it → at least one commit must carry it;
3. a commit without the watermark is a person's, and passes untouched — in a harness pull request
   too, so a reviewer's fix needs no watermark;
4. neither → a person's pull request, passed unchanged;
5. a missing, misplaced or modified watermark, on a commit or the description, fails.

## What this cannot prove

- **Who did the work.** The watermark is typed text. It marks work as the harness's; it does not
  prove it.
- **Harness work committed without it.** A session that bypasses the helper and commits under a
  person's message with no watermark is a person's commit to every check here, in a harness pull
  request too (rule 3). Only a malformed watermark is caught.

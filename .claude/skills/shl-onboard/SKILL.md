---
name: shl-onboard
description: Installs the SHL delivery harness into a hub, a spoke or, with --global, the global context repository, or with --upgrade moves an installed hub and its spokes, or the global context repository, to another released version. Fetches the chosen version from GitHub into a temporary folder and follows the procedure inside it. Never merges.
argument-hint: [--upgrade [--version X.Y.Z | --ref <branch or commit>] [--spokes] [--dry-run]] [--global] [--version X.Y.Z | --ref <branch or commit>]
---

<!-- Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-06 -->

# Skill — shl-onboard, the starter

**You fetch one version of the harness library and hand over to the procedure inside it. A
script picks the version. You never choose, compare or type a version number yourself.**

This file is the same in a person's own skills folder (`~/.claude/skills/shl-onboard/SKILL.md`)
and in a hub (`.claude/skills/shl-onboard/SKILL.md`). It holds no install logic, so it rarely
changes.

The library lives at `https://github.com/SHL-India/shl-harness`. When
`SHL_HARNESS_URL` is set, it names another address: a mirror, or a local clone for testing.
**INTEGRATION POINT**: another host, another address.

Talk to the person in plain English: short sentences, everyday words. Ask one question per turn.
Letter fixed choices a), b), with a) the suggestion.

Every stop below goes through §5 first.

## 1. Clone

Your shell does not keep variables from one command to the next. So this file uses a written
path instead. Make the temporary folder and print its path:

```bash
mktemp -d
```

Note the absolute path it prints. Below, `<LIB_DIR>` stands for that path. In every later
command, write the literal path in place of `<LIB_DIR>`. Never rely on a variable set in an
earlier command.

```bash
git clone --quiet "${SHL_HARNESS_URL:-https://github.com/SHL-India/shl-harness}" <LIB_DIR>/shl-harness
```

The clone keeps the full history: an upgrade reads the hub's old library version from it. If
the clone fails, say so in plain words, clean up (§5) and stop. The usual cause is that this
person's git cannot read the repository.

Then fetch the heads of the library's pull requests too:

```bash
git -C <LIB_DIR>/shl-harness fetch --quiet origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
```

A hub moved with `--ref` to a branch may hold a commit that is on no branch any more: the
branch was squash-merged and deleted. GitHub keeps every pull request's last commit under these
names, so the picker can still find the hub's old version. **INTEGRATION POINT**: this naming is
GitHub's; another host keeps such commits under other names, or not at all. If this fetch fails,
go on: it is not fatal. Only a hub on such a commit needs it.

## 2. Pick

First find the commit the picker runs from. With `--ref R`, it is R. Otherwise it is the
newest release: the highest tag of the exact form `vX.Y.Z`, digits only.

```bash
git -C <LIB_DIR>/shl-harness tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1
```

If there is no `--ref` and the command prints nothing, say plainly that no release can be
installed this way yet, clean up (§5) and stop.

Then check out that commit, writing the tag or the `--ref` value in place of `<FROM>`:

```bash
git -C <LIB_DIR>/shl-harness checkout --quiet <FROM>
```

If the checkout fails, say in plain words that the ref was not found, clean up (§5) and stop.

Last, check that `<LIB_DIR>/shl-harness/scripts/pick-version.mjs` exists at that commit. If it
does not, clean up (§5) and stop. With `--ref`, say plainly that this ref is older than this way
of installing, so it cannot be installed from. Without `--ref`, say plainly that no release can
be installed this way yet.

Run the picker from the repository in front of you, with the call's own arguments:

| The call | The picker's arguments |
|---|---|
| `/shl-onboard` | `install` |
| `/shl-onboard --ref R` | `install --ref R` |
| `/shl-onboard --version X.Y.Z` | `install --version X.Y.Z` |
| `/shl-onboard --global` | `install` |
| `/shl-onboard --global --version X.Y.Z` | `install --version X.Y.Z` |
| `/shl-onboard --global --ref R` | `install --ref R` |
| `/shl-onboard --upgrade` | `upgrade` |
| `/shl-onboard --upgrade --version X.Y.Z` | `upgrade --version X.Y.Z` |
| `/shl-onboard --upgrade --ref R` | `upgrade --ref R` |

```bash
node <LIB_DIR>/shl-harness/scripts/pick-version.mjs <the picker's arguments> > <LIB_DIR>/pick.json
```

`--spokes`, `--dry-run` and `--global` are not the picker's. Keep them for the procedure.

- Exit `1`: the picker refused. Say why in plain words, with what the person can do, and stop.
- Exit `2`: it could not reach git or GitHub. Say what it could not reach and stop. Never guess.
- Exit `3`: the arguments are wrong. Show the usage line it printed and stop.

## 3. Ask, only when breaking changes are crossed

Read `<LIB_DIR>/pick.json`. If `target.release` is `false`, say once that the target is not a release.

If `breaking` is not empty, show each entry on one line: the version, the pull request number
and title, and its "What to do" line. When `direction` is `down`, say that each "What to do"
line describes the move up, so the person undoes it by hand. Then ask:

> a) Go on
> b) Stop

On b), stop.

## 4. Hand over

```bash
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).target.commit)' <LIB_DIR>/pick.json
```

Then check out the commit it printed, writing it in place of `<COMMIT>`:

```bash
git -C <LIB_DIR>/shl-harness checkout --quiet <COMMIT>
```

Read `<LIB_DIR>/shl-harness/onboard/PROCEDURE.md` and follow it, from the repository in front
of you, with:

- `$LIB` — the clone, at the picked commit. It stands for `<LIB_DIR>/shl-harness`.
- `$LIB_PICK` — the picker's answer. It stands for `<LIB_DIR>/pick.json`.
- the call's own arguments: `--upgrade`, `--version`, `--ref`, `--spokes`, `--dry-run`, `--global`

That is the whole contract between this file and the procedure.

## 5. Clean up

```bash
rm -rf <LIB_DIR>
```

Always: when the procedure is done, when it stopped, and when anything above stopped.

## Never

- Never pick, compare or type a version number yourself.
- Never install from anything but `$LIB` at the picked commit.
- Never edit a file inside `$LIB`.
- Never merge any pull request. Every merge is human.

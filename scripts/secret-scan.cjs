#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-12
/**
 * secret-scan.cjs — run a spoke's own secret scan before a commit exists, and over every commit
 * a pull request carries.
 *
 * A committed secret stays in the history, so it is caught before the commit: the scan runs as
 * the spoke's pre-commit hook, and again as a row of check-staged.mjs, inside harness-commit.mjs,
 * for every commit the harness makes. A hook can be skipped (`--no-verify`, or a clone where it
 * was never installed), so the spoke's required story-gate check runs it a third time over the
 * pull request's commits.
 *
 * The scanner is the spoke's, never the harness's. `SECRET_SCAN_COMMAND` in checks.env names it,
 * and it is mandatory: missing, empty, `UNRESOLVED` and `none` are all refused. The harness ships
 * no scanner and picks none.
 *
 * Where the command is read from. Like every other check, from the trunk and never from the
 * checkout being judged, so a branch that edits its own checks.env does not change how its own
 * commits are scanned until a person merges it.
 *   --staged   checks.env at the head of the spoke's trunk, force-fetched. The trunk rule names
 *              it: HARNESS_SPOKE_TRUNK where set, otherwise TRUNK_FOR_HUB in checks.env at HEAD
 *              (or in this checkout's checks.env where HEAD has none). `default` is origin's
 *              default branch. The branch must exist on origin, and TRUNK_FOR_HUB at its tip
 *              must name the same branch
 *   --range    checks.env at the base commit of the range
 *   --history  this checkout's checks.env: it runs once, at the install, where no trunk has one
 * Where there is nothing to read it from, it is this checkout's checks.env: a checkout with no
 * `origin` (it cannot push, so its commits are judged where they land), and a trunk or base
 * with no checks.env, which is the spoke install's own pull request, where a person reads the
 * file in the diff before they merge it. What the command names (a script in the checkout) is
 * the checkout's own.
 *
 * The command's contract
 *   - It runs unchanged on Windows, Linux and Mac, in a clean checkout where only git and Node
 *     are present. Anything else it needs, it fetches itself. It is run through the platform's
 *     shell (sh, or cmd.exe on Windows), so make, bash and Python tools do not qualify; a
 *     package.json script or `node <script>` does.
 *   - It reads what to scan from two environment variables:
 *       SHL_SCAN_MODE=staged                   the index, before a commit
 *       SHL_SCAN_MODE=range SHL_SCAN_RANGE=<revisions>
 *                                              every commit `git log <revisions>` lists, so
 *                                              a secret added and then deleted is still
 *                                              found: `<base>..<head>` for a pull request,
 *                                              `HEAD` for the whole history at the install
 *   - Exit 0 is clean. Anything else refuses, and its output is passed through as it is.
 *
 *   usage:  node .githooks/pre-commit                       git runs it: the staged scan
 *           node .githooks/pre-commit --install             set core.hooksPath for this clone
 *           node scripts/secret-scan.cjs --repo <dir> [--staged | --range <base>..<head> | --history]
 *           ... [--if-declared]                             skip, with a warning, where the key
 *                                                           is not a command (the upgrade only)
 *
 * Installed twice from one source: verbatim as `.githooks/pre-commit` in every spoke, and as
 * `scripts/secret-scan.cjs` in the hub, where harness-commit.mjs and story-gate run it. It is
 * written to load as CommonJS or as an ES module, because a file with no extension takes the
 * spoke's package.json type: no import or export statement, no require.
 *
 * It reads the commands file with the grammar spoke-rules.mjs and check-staged.mjs carry (flat
 * KEY=value, `#` comments and blank lines skipped, the first value wins; the value `none` or
 * `UNRESOLVED` alone or followed by ` — <text>`), and applies the trunk rule of spoke-trunk.mjs,
 * both copied here because a spoke has no hub scripts to import.
 *
 * Exit codes, as check-staged.mjs has them: 0 clean, or skipped under --if-declared · 1 the scan
 * found something or failed, or the key is `none` (never allowed) · 2 cannot verify: the key
 * missing, empty or `UNRESOLVED`, the trunk unreachable, missing or not agreed, no repository, no
 * commands file, the command not installed on this machine (126, 127), the shell could not start ·
 * 3 usage · 4 internal. Node standard library only, plus git.
 */

(async () => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync, readFileSync, readdirSync, realpathSync } = await import('node:fs');
  const { basename, dirname, join, relative, sep } = await import('node:path');
  const { writeSync } = await import('node:fs');
  // The last line of an exit 2, 3 or 4 names this script and its code, so a shell line that hides
  // the code, with a pipe or `; echo`, still tells the harness's failure record. Written at once,
  // so a process.exit() never loses it.
  process.on('exit', (code) => { if (code >= 2 && code <= 4) { try { writeSync(2, `HARNESS EXIT: secret-scan ${code}\n`); } catch { /* stderr is closed */ } } });

  const KEY = 'SECRET_SCAN_COMMAND';
  const TRUNK_KEY = 'TRUNK_FOR_HUB';
  const TRUNK_VAR = 'HARNESS_SPOKE_TRUNK';
  const TRUNK_DEFAULT = 'default';
  const REMOTE = 'origin';
  const RANGE = /^[^\s.][^\s]*\.\.[^\s.][^\s]*$/;

  class ScanError extends Error {
    constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
  }

  const git = (dir, args) => {
    const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (res.error) throw new ScanError(2, `git could not run: ${res.error.message}`, 'git-failed');
    return res;
  };

  function parseArgs(argv) {
    const o = { mode: 'staged', range: null, repo: '.', install: false, ifDeclared: false };
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      const value = () => { if (argv[i + 1] === undefined) throw new ScanError(3, `${a} needs a value`); i += 1; return argv[i]; };
      if (a === '--staged') o.mode = 'staged';
      else if (a === '--range') { o.mode = 'range'; o.range = value(); if (o.range.search(RANGE) !== 0) throw new ScanError(3, `--range takes <base>..<head>, not "${o.range}"`); }
      else if (a === '--history') { o.mode = 'range'; o.range = 'HEAD'; }
      else if (a === '--repo') o.repo = value();
      else if (a === '--install') o.install = true;
      else if (a === '--if-declared') o.ifDeclared = true;
      else throw new ScanError(3, `unknown argument: ${a}`);
    }
    if (o.install && (o.mode === 'range' || o.ifDeclared)) throw new ScanError(3, '--install takes no scan arguments');
    return o;
  }

  function topLevel(dir) {
    const res = git(dir, ['rev-parse', '--show-toplevel']);
    if (res.status !== 0) throw new ScanError(2, `${dir} is not a git checkout`, 'not-a-checkout');
    return res.stdout.trim();
  }

  /** The value of `key` in a commands file's text, or null where it has no such key. */
  function valueIn(text, key) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && m[1] === key) return m[2].trim();
    }
    return null;
  }

  /** This checkout's checks.env: the install's own, and a checkout that cannot push. */
  function here(root, why) {
    const file = join(root, 'checks.env');
    if (!existsSync(file)) throw new ScanError(2, `no checks.env at ${root}; a spoke's secret scan is named there`, 'config-invalid');
    return { text: readFileSync(file, 'utf8'), from: `this checkout's checks.env (${why})` };
  }

  /** `default`, or a name git accepts as a branch, unchanged. `UNRESOLVED` is never a trunk. */
  function isTrunkName(root, value) {
    if (typeof value !== 'string' || value === '') return false;
    if (value === TRUNK_DEFAULT) return true;
    if (value === '@' || value === 'UNRESOLVED' || value.startsWith('refs/')) return false;
    const res = git(root, ['check-ref-format', '--branch', value]);
    return res.status === 0 && res.stdout.trim() === value;
  }

  /** The trunk's name: HARNESS_SPOKE_TRUNK, or TRUNK_FOR_HUB at HEAD, or in this checkout's checks.env. */
  function trunkName(root) {
    const named = process.env[TRUNK_VAR];
    if (named) {
      if (!isTrunkName(root, named)) throw new ScanError(2, `${TRUNK_VAR} is "${named}"; it must be "${TRUNK_DEFAULT}" or a branch name`, 'config-invalid');
      return { name: named, from: TRUNK_VAR };
    }
    const atHead = checksAt(root, 'HEAD', 'HEAD', true);
    const src = atHead || (existsSync(join(root, 'checks.env')) ? here(root, 'HEAD has none: the spoke install\'s own branch') : null);
    if (!src) throw new ScanError(2, `${TRUNK_VAR} is not set and there is no checks.env at HEAD, so there is no ${TRUNK_KEY} to name the trunk`, 'config-invalid');
    const value = valueIn(src.text, TRUNK_KEY);
    if (value === null || value === '') throw new ScanError(2, `${TRUNK_KEY} is ${value === null ? 'missing' : 'empty'} in ${src.from}; it is required: "${TRUNK_DEFAULT}" or the harness trunk's branch name`, 'trunk-undeclared');
    if (!isTrunkName(root, value)) throw new ScanError(2, `${TRUNK_KEY}=${value} in ${src.from} is not "${TRUNK_DEFAULT}" or a branch name`, 'config-invalid');
    return { name: value, from: `${TRUNK_KEY} in ${src.from}` };
  }

  /** The branch a trunk name stands for, confirmed on origin. */
  function branchFor(root, name) {
    if (name === TRUNK_DEFAULT) {
      const ls = git(root, ['ls-remote', '--symref', REMOTE, 'HEAD']);
      if (ls.status !== 0) throw new ScanError(2, `could not reach ${REMOTE} (${(ls.stderr || '').trim().split('\n')[0]}), so the scan command cannot be read from the trunk`, 'remote-unreachable');
      const m = ls.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
      if (!m) throw new ScanError(2, `${REMOTE} reports no default branch, so "${TRUNK_DEFAULT}" names no trunk to read the scan command from`, 'no-default-branch');
      return m[1];
    }
    const ls = git(root, ['ls-remote', '--heads', REMOTE, `refs/heads/${name}`]);
    if (ls.status !== 0) throw new ScanError(2, `could not reach ${REMOTE} (${(ls.stderr || '').trim().split('\n')[0]}), so the scan command cannot be read from the trunk`, 'remote-unreachable');
    if (!ls.stdout.split('\n').some((l) => l.endsWith(`\trefs/heads/${name}`))) throw new ScanError(2, `the trunk is ${name}, and ${REMOTE} has no branch ${name}`, 'trunk-missing');
    return name;
  }

  /** The trunk rule, as spoke-trunk.mjs applies it: the trunk, force-fetched, and its agreement. */
  function trunkChecks(root) {
    const { name, from } = trunkName(root);
    const trunk = branchFor(root, name);
    const ref = `refs/remotes/${REMOTE}/${trunk}`;
    const fetched = git(root, ['fetch', '--quiet', '--no-tags', '--force', REMOTE, `+refs/heads/${trunk}:${ref}`]);
    if (fetched.status !== 0) throw new ScanError(2, `could not fetch ${REMOTE}/${trunk} (${(fetched.stderr || '').trim().split('\n')[0]})`, 'fetch-failed');
    const at = checksAt(root, ref, `${REMOTE}/${trunk}`);
    if (at) {
      const said = valueIn(at.text, TRUNK_KEY);
      if (said === null || said === '') throw new ScanError(2, `${at.from} has ${TRUNK_KEY} ${said === null ? 'missing' : 'empty'}; it must name this trunk`, 'trunk-undeclared');
      let agrees = said === name;
      if (!agrees && isTrunkName(root, said)) {
        try { agrees = branchFor(root, said) === trunk; } catch (err) { agrees = false; }
      }
      if (!agrees) throw new ScanError(2, `the trunk is ${name} (from ${from}), and ${at.from} has ${TRUNK_KEY}=${said}. The two must name the same branch`, 'trunk-mismatch');
    }
    return { trunk, ref, name: `${REMOTE}/${trunk}`, at };
  }

  /** checks.env as git holds it at `rev`, or null where that commit has none (or, with `soft`, where there is no such commit). */
  function checksAt(root, rev, name, soft = false) {
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    if (commit.status !== 0 && soft) return null;
    if (commit.status !== 0) throw new ScanError(2, `cannot read ${name}: no such commit`, 'commit-not-found');
    const blob = git(root, ['rev-parse', '--verify', '--quiet', `${commit.stdout.trim()}:checks.env`]);
    if (blob.status !== 0) return null;
    const text = git(root, ['cat-file', 'blob', blob.stdout.trim()]);
    if (text.status !== 0) throw new ScanError(2, `cannot read checks.env at ${name}`, 'git-failed');
    return { text: text.stdout, from: `checks.env at ${name} ${commit.stdout.trim().slice(0, 12)}` };
  }

  /** The checks.env the command is read from, and where it came from. */
  function source(root, o) {
    if (o.mode === 'range') {
      if (o.range === 'HEAD') return here(root, 'the whole history at the install, before any trunk has one');
      const base = o.range.split('..')[0];
      return checksAt(root, base, `the base of the range, ${base}`) || here(root, `the base ${base} has none: the spoke install's own pull request`);
    }
    if (!git(root, ['remote']).stdout.split('\n').includes(REMOTE)) return here(root, 'no origin remote: this checkout cannot push');
    const t = trunkChecks(root);
    return t.at || here(root, `${t.name} has none: the spoke install's own branch`);
  }

  /**
   * What the value means: { command } or { problem, code }. `none` is refused (1): it is a choice,
   * and not one a spoke has. Missing, empty and `UNRESOLVED` cannot verify (2), as in check-staged.
   */
  function judge(value) {
    if (value !== null && value !== '' && value.search(/^(UNRESOLVED|none)\b/) !== 0) return { command: value };
    const state = value === null ? 'missing' : value === '' ? 'empty' : value;
    const none = value !== null && value.search(/^none\b/) === 0;
    const invalid = value !== null && value !== '' && !(value === 'none' || value === 'UNRESOLVED' || value.search(/^(none|UNRESOLVED)\s+—\s+\S/) === 0);
    const why = `${KEY} is ${state} in checks.env. A spoke's secret scan is mandatory: name a command from this repository that runs on Windows, Linux and Mac`;
    return { problem: invalid ? `${KEY}=${value} is not a command, "UNRESOLVED" or "UNRESOLVED — <reason>"` : why, code: none && !invalid ? 1 : 2 };
  }

  function scan(o) {
    const root = topLevel(o.repo);
    const src = source(root, o);
    const found = judge(valueIn(src.text, KEY));
    if (found.problem) {
      if (o.ifDeclared) {
        process.stderr.write(`SECRET SCAN SKIPPED — ${found.problem}. This commit is not scanned, and story-gate refuses the pull request until the key is a command\n`);
        return 0;
      }
      throw new ScanError(found.code, `${found.problem} (read from ${src.from})`, found.code === 2 ? 'config-invalid' : null);
    }
    const command = found.command;
    const env = { ...process.env, SHL_SCAN_MODE: o.mode };
    if (o.mode === 'range') env.SHL_SCAN_RANGE = o.range;
    else delete env.SHL_SCAN_RANGE;
    const what = o.mode === 'staged' ? 'the staged changes' : o.range === 'HEAD' ? 'every commit in the history' : `every commit in ${o.range}`;
    process.stderr.write(`SECRET SCAN — ${command} over ${what}, read from ${src.from}\n`);
    const res = spawnSync(command, { cwd: root, env, shell: true, stdio: 'inherit' });
    if (res.error) throw new ScanError(2, `${KEY} could not start (${res.error.message}): ${command}`, 'tool-missing');
    if (res.status === 126 || res.status === 127) {
      throw new ScanError(2, `${KEY} could not run (exit ${res.status}): the tool is not installed on this machine, or cannot be run: ${command}`, 'tool-missing');
    }
    if (res.status !== 0) {
      const signal = res.signal ? `, signal ${res.signal}` : '';
      throw new ScanError(1, `${KEY} refused ${what} (exit ${res.status}${signal}): ${command}. A secret that reaches a commit stays in the history; rotate any secret it found, even after removing it`);
    }
    process.stderr.write(`SECRET SCAN CLEAN — ${what}\n`);
    return 0;
  }

  // --install: point this clone's hooks at the folder this file is in. Refused where the clone
  // already runs hooks from somewhere else, rather than switching them off.
  function install(o) {
    const root = topLevel(o.repo);
    const self = realpathSync(process.argv[1]);
    const rel = relative(realpathSync(root), dirname(self)).split(sep).join('/');
    if (basename(self) !== 'pre-commit' || rel === '' || rel.startsWith('..')) {
      throw new ScanError(3, `--install is run as the hook inside the spoke (node .githooks/pre-commit --install), not as ${self}`);
    }
    const current = git(root, ['config', '--get', 'core.hooksPath']).stdout.trim();
    if (current && current !== rel) {
      throw new ScanError(1, `core.hooksPath is already ${current}. Not changed: add "node ${rel}/pre-commit" to the pre-commit hook in ${current} instead`);
    }
    if (!current) {
      const hooks = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).stdout.trim();
      const own = existsSync(hooks) ? readdirSync(hooks).filter((f) => !f.endsWith('.sample')) : [];
      if (own.length) {
        throw new ScanError(1, `${hooks} holds hooks of its own (${own.join(', ')}), which core.hooksPath would switch off. Not changed: add "node ${rel}/pre-commit" to its pre-commit hook instead`);
      }
    }
    const res = git(root, ['config', 'core.hooksPath', rel]);
    if (res.status !== 0) throw new ScanError(2, `git config core.hooksPath ${rel}: ${res.stderr.trim()}`, 'git-failed');
    process.stdout.write(`SECRET SCAN HOOK INSTALLED — core.hooksPath is ${rel}; every commit in this clone runs ${KEY} first\n`);
    return 0;
  }

  try {
    const o = parseArgs(process.argv.slice(2));
    // harness-commit.mjs ran the scan already, for this exact index, before calling git commit.
    if (!o.install && o.mode === 'staged' && process.env.SHL_SECRET_SCANNED === '1') process.exit(0);
    process.exit(o.install ? install(o) : scan(o));
  } catch (err) {
    const code = err instanceof ScanError ? err.code : 4;
    const label = { 1: 'SECRET SCAN REFUSED', 2: 'SECRET SCAN CANNOT VERIFY', 3: 'USAGE' }[code] || 'INTERNAL';
    process.stderr.write(`${label} — ${err.message}\n`);
    // This line, just before the exit line, names the cause as a token of REASONS in scripts/spoke-remote.mjs, which this
    // file does not import. `make reasons` proves the tokens.
    if (code === 2 && err.reason) process.stderr.write(`REASON: ${err.reason}\n`);
    process.exit(code);
  }
})();

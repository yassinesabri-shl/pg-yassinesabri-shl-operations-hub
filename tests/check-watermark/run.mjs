#!/usr/bin/env node
/**
 * run.mjs — the fixture suite for the harness watermark: check-watermark.mjs (the local
 * commit-msg check and the pull-request check), harness-commit.mjs (the one way the harness
 * commits), and every commit and pull-request path's use of them.
 *
 *   usage:  node run.mjs            run every fixture
 *           node run.mjs 3 7        run only the numbered fixtures
 *           node run.mjs --keep     leave the throwaway repositories on disk
 *
 * A fixture is a message, or a REPOSITORY STATE — a throwaway repository with real commits —
 * and the scripts are run as a hub runs them. Every repository a fixture judges is throwaway:
 * the watermark binds installed hubs and spokes, never the library's own history, and nothing
 * here asserts anything about the commits of the repository the suite runs in. Exit code and text are asserted. Fixtures marked
 * library-only read files an installed hub does not carry and are reported as skipped there.
 *
 * Reads the whole tree it is installed in. That line is read literally by scripts/upgrade.mjs,
 * which runs every other suite only when a file it reads changed, and this one on every upgrade.
 *
 * Node standard library only, plus git via child_process. No test framework.
 * Exit 0 if every fixture that runs passes, 1 if any fails.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIBRARY = existsSync(join(LIBRARY_ROOT, 'accelerator', 'gate', 'check-watermark.mjs'));
const ROOT = LIBRARY ? LIBRARY_ROOT : resolve(HERE, '..', '..');
const SCRIPTS = LIBRARY ? join(ROOT, 'accelerator', 'gate') : join(ROOT, 'scripts');
// The two conditions that run a step after an earlier failure: always, or (story-gate) wherever
// checks.env named a hub to clone.
const CHECK = join(SCRIPTS, 'check-watermark.mjs');
const COMMIT = join(SCRIPTS, 'harness-commit.mjs');
if (!existsSync(CHECK) || !existsSync(COMMIT)) {
  console.error(`cannot locate check-watermark.mjs and harness-commit.mjs under ${SCRIPTS}`);
  process.exit(4);
}

const W = 'Generated-by: SHL Agentic Harness';
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'watermark-home-'));
const ENV = {
  ...process.env,
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
for (const k of ['HARNESS_COMMIT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete ENV[k];

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
function spawn(cwd, cmd, args, env = {}, input) {
  const res = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8', input });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}` };
}

/** A repository with a person's identity configured in it, and one person's commit. */
function repo(root) {
  const work = join(root, 'work');
  git(root, ['init', '-q', '--initial-branch', 'main', work]);
  git(work, ['config', 'user.name', 'A Person']);
  git(work, ['config', 'user.email', 'person@example.invalid']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(work, 'README.md'), '# repo\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'chore: the trunk']);
  return { work, base: git(work, ['rev-parse', 'HEAD']).trim() };
}
const stage = (work, name = `f-${Math.random().toString(36).slice(2)}.txt`) => { writeFileSync(join(work, name), 'x\n'); git(work, ['add', '-A']); };
const helper = (work, paras, env = {}) => spawn(work, process.execPath, [COMMIT, ...paras.flatMap((p) => ['-m', p])], env);
/** A commit made by hand, bypassing the helper: the shapes a person or a misbehaving session makes. */
const byHand = (work, message, { noVerify = false, env = {} } = {}) => {
  stage(work);
  return spawn(work, 'git', ['commit', '-q', ...(noVerify ? ['--no-verify'] : []), '-F', '-'], env, message);
};
const head = (work) => git(work, ['rev-parse', 'HEAD']).trim();
function writeFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
}

/** The local check on one message, as the commit-msg hook runs it for a harness-managed commit. */
function hook(root, message, env = { HARNESS_COMMIT: '1' }) {
  const file = join(root, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  return spawn(root, process.execPath, [CHECK, '--commit-msg', file], env);
}
/** The pull-request check, the description written where the workflow writes the event's. */
function gate(r, root, description, range = `${r.base}..HEAD`) {
  const body = join(root, 'pr-body.md');
  writeFileSync(body, `${description}\n`);
  return spawn(r.work, process.execPath, [CHECK, '--pr-body', body, range]);
}
/** Each of several messages through the local check; status 1 only if every one was refused. */
function allRefused(root, messages) {
  const accepted = messages.filter((m) => hook(root, m).status !== 1);
  return { status: accepted.length ? 0 : 1, output: accepted.length ? `accepted: ${accepted.map((m) => JSON.stringify(m)).join('; ')}` : `all ${messages.length} refused` };
}

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null);
const L = (lib, installed) => (LIBRARY ? lib : installed);
const RAW_COMMIT = /\bgit(\s+-[Cc]\s+\S+)*\s+commit\s+-/;
const COMMANDS = ['feature', 'decompose', 'dev-spec', 'dev-sprint', 'qa-sprint', 'survey-repo', 'add-repo', 'add-context', 'check-global'];
const COMMIT_FILES = [
  ...COMMANDS.map((c) => L(`accelerator/commands/${c}.md`, `.claude/commands/${c}.md`)),
  L('accelerator/skills/write-tests/SKILL.md', '.claude/skills/write-tests/SKILL.md'),
  L('accelerator/skills/implement-work-item/SKILL.md', '.claude/skills/implement-work-item/SKILL.md'),
  L('accelerator/AGENTS.template.md', 'AGENTS.md'),
];
const PR_FILES = [
  ...COMMANDS.map((c) => L(`accelerator/commands/${c}.md`, `.claude/commands/${c}.md`)),
  L('accelerator/AGENTS.template.md', 'AGENTS.md'),
];
const INSTALL_FILES = ['install-hub.md', 'install-spoke.md'].map((f) => `onboard/references/${f}`);

/* ------------------------------------------------------------------- fixtures */

const FIXTURES = [
  /* --------------------------------------------- the form, through the local check */
  { n: 1, name: 'a harness commit whose final line is exactly the watermark passes', run: (root) => hook(root, `feat(SVC-1): a change\n\nWhy.\n\n${W}\n`), exit: 0 },
  {
    n: 2, name: 'Co-authored-by and Signed-off-by trailers directly before the watermark pass, and git still reads all three as trailers',
    run: (root) => {
      const message = `feat: x\n\nWhy.\n\nCo-authored-by: Someone <s@example.invalid>\nSigned-off-by: A Person <person@example.invalid>\n${W}\n`;
      const r = hook(root, message);
      const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' }).trim().split('\n');
      return { status: r.status, output: `${r.output}trailers=${JSON.stringify(parsed)}` };
    },
    exit: 0, includes: [`trailers=${JSON.stringify(['Co-authored-by: Someone <s@example.invalid>', 'Signed-off-by: A Person <person@example.invalid>', W])}`],
  },
  {
    n: 3, name: 'a harness-managed commit without the watermark fails, before the commit exists',
    run: (root) => hook(root, 'feat: x\n\nWhy.\n'), exit: 1, includes: [`it does not end with the line "${W}"`, 'the commit was not created'],
  },
  {
    n: 4, name: 'a modified watermark fails: case, a leading or trailing space, punctuation, a word more or less',
    run: (root) => allRefused(root, ['Generated by SHL Agentic Harness', 'generated-by: shl agentic harness', 'Generated-By: SHL Agentic Harness', 'Generated-by:SHL Agentic Harness', 'Generated-by:  SHL Agentic Harness', 'Generated-by : SHL Agentic Harness', `${W} `, ` ${W}`, `${W}.`, `${W} v2`, 'Generated-by: SHL Harness'].map((l) => `feat: x\n\n${l}\n`)),
    exit: 1, includes: ['all 11 refused'],
  },
  {
    n: 5, name: 'the watermark in the middle of the message fails',
    run: (root) => hook(root, `feat: x\n\n${W}\n\nMore text after it.\n`), exit: 1, includes: ['the watermark is not its final line'],
  },
  {
    n: 6, name: 'the watermark in Markdown, a quote, a list item, inline code, a code block or an HTML comment fails',
    run: (root) => allRefused(root, [`**${W}**`, `_${W}_`, `# ${W}`, `> ${W}`, `- ${W}`, `* ${W}`, `1. ${W}`, `\`${W}\``, `\`\`\`\n${W}\n\`\`\``, `\`\`\`\n${W}`, `~~~\n${W}`, `<!-- ${W} -->`, `<!--\n${W}`, `<!--\nx --> <!--\n${W}`].map((l) => `feat: x\n\n${l}\n`)),
    exit: 1, includes: ['all 14 refused'],
  },
  {
    n: 34, name: 'the watermark written directly under prose is not a git trailer, and fails',
    run: (root) => hook(root, `feat: x\n\nWhy it changed.\n${W}\n`), exit: 1, includes: ['git does not read the watermark as a trailer'],
  },
  {
    n: 7, name: 'a Co-authored-by trailer after the watermark fails — the watermark is the final line',
    run: (root) => hook(root, `feat: x\n\n${W}\n\nCo-authored-by: Someone <s@example.invalid>\n`), exit: 1, includes: ['the watermark is not its final line'],
  },
  {
    n: 8, name: 'the watermark twice — once in the middle, once last — fails',
    run: (root) => hook(root, `feat: x\n\n${W}\n\n${W}\n`), exit: 1, includes: ['appears 2 times'],
  },
  {
    n: 9, name: "a person's commit without the watermark passes the local check untouched",
    run: (root) => hook(root, 'fix: by hand\n', {}), exit: 0, excludes: ['FAIL'],
  },
  {
    n: 10, name: 'comment lines and a scissors section are dropped before the check, and the message file is rewritten to the checked text',
    run: (root) => {
      const r = hook(root, `feat: x\n\n${W}\n# Please enter the commit message.\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n`);
      return { status: r.status, output: `${r.output}file=${JSON.stringify(readFileSync(join(root, 'COMMIT_EDITMSG'), 'utf8'))}` };
    },
    exit: 0, includes: [`file=${JSON.stringify(`feat: x\n\n${W}\n`)}`],
  },

  /* ---------------------------------------------------- the helper: harness-commit.mjs */
  {
    n: 11, name: "the helper commits with the watermark last, and leaves the person's name, email and git configuration exactly as they were",
    run: (root) => {
      const r = repo(root);
      const before = git(r.work, ['config', '--list', '--local']);
      stage(r.work);
      const made = helper(r.work, ['feat(SVC-1): a change', 'Why it changed.']);
      if (made.status !== 0) return made;
      const msg = git(r.work, ['log', '-1', '--format=%B']);
      const who = git(r.work, ['log', '-1', '--format=%an <%ae> / %cn <%ce> / %G?']).trim();
      const after = git(r.work, ['config', '--list', '--local']);
      const p = [];
      if (msg.trimEnd().split('\n').pop() !== W) p.push(`last line ${JSON.stringify(msg.trimEnd().split('\n').pop())}`);
      if (who !== 'A Person <person@example.invalid> / A Person <person@example.invalid> / N') p.push(`identity or signing changed: ${who}`);
      if (before !== after) p.push('the helper changed the git configuration');
      return { status: p.length ? 1 : 0, output: `${made.output}${p.join('\n') || 'person unchanged, configuration unchanged, watermark last'}` };
    },
    exit: 0, includes: ['HARNESS COMMIT', 'person unchanged, configuration unchanged, watermark last'],
  },
  {
    n: 12, name: 'the helper appends the watermark as the last trailer, so Co-authored-by and Signed-off-by stay trailers; without trailers it is a final paragraph of its own',
    run: (root) => {
      const r = repo(root);
      stage(r.work);
      helper(r.work, ['feat: x', 'Why.', 'Co-authored-by: Someone <s@example.invalid>\nSigned-off-by: A Person <person@example.invalid>']);
      const trailers = git(r.work, ['log', '-1', '--format=%(trailers)']).trim().split('\n');
      stage(r.work);
      helper(r.work, ['feat: y', 'No trailers.']);
      const plain = git(r.work, ['log', '-1', '--format=%B']).trimEnd().split('\n').slice(-3);
      return { status: 0, output: `trailers=${JSON.stringify(trailers)} plain=${JSON.stringify(plain)}` };
    },
    exit: 0, includes: [`trailers=${JSON.stringify(['Co-authored-by: Someone <s@example.invalid>', 'Signed-off-by: A Person <person@example.invalid>', W])}`, `plain=${JSON.stringify(['No trailers.', '', W])}`],
  },
  {
    n: 13, name: 'the helper refuses a message that already carries the watermark, and commits nothing',
    run: (root) => {
      const r = repo(root);
      stage(r.work);
      const res = helper(r.work, ['feat: x', `${W}.`]);
      return { status: res.status, output: `${res.output}${head(r.work) === r.base ? 'nothing committed' : 'COMMITTED'}` };
    },
    exit: 3, includes: ['already carries the watermark', 'nothing committed'],
  },
  {
    n: 14, name: 'with the commit-msg hook installed: the helper passes it, a person passes it, a malformed watermark and a harness commit without one are blocked',
    run: (root) => {
      const r = repo(root);
      const installed = spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      if (installed.status !== 0) return installed;
      stage(r.work);
      const viaHelper = helper(r.work, ['feat: through the helper']).status;
      const person = byHand(r.work, 'fix: by hand\n').status;
      const before = head(r.work);
      const malformed = byHand(r.work, `feat: x\n\n> ${W}\n`);
      const unmarked = byHand(r.work, 'feat: x\n', { env: { HARNESS_COMMIT: '1' } });
      const created = head(r.work) !== before;
      return { status: 0, output: `helper=${viaHelper} person=${person} malformed=${malformed.status} unmarked=${unmarked.status} created=${created}\n${malformed.output}` };
    },
    exit: 0, includes: ['helper=0 person=0 malformed=1 unmarked=1 created=false', 'the commit was not created'],
  },
  {
    n: 15, name: '--install-hook --worktree writes per-worktree config only; the person\'s checkout is untouched',
    run: (root) => {
      const r = repo(root);
      const wt = join(root, 'wt');
      git(r.work, ['worktree', 'add', '-q', '-b', 'feature/SVC-2-x', wt, 'main']);
      const res = spawn(r.work, process.execPath, [COMMIT, '--install-hook', wt, '--worktree']);
      const inWt = git(wt, ['config', '--show-origin', '--get', 'core.hooksPath']);
      const inMain = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: r.work, env: ENV }).status;
      return { status: res.status, output: `${res.output}worktree=${inWt.includes('config.worktree') ? 'config.worktree' : inWt} main=${inMain === 0 ? 'SET' : 'unset'}` };
    },
    exit: 0, includes: ['worktree=config.worktree', 'main=unset'],
  },

  /* ---------------------------------------------------------- the pull-request check */
  {
    n: 16, name: 'a harness pull request whose commits and description end with the watermark passes',
    run: (root) => { const r = repo(root); stage(r.work); helper(r.work, ['feat: one']); stage(r.work); helper(r.work, ['feat: two']); return gate(r, root, `Adds two things.\n\n${W}`); },
    exit: 0, includes: ['WATERMARK OK — a harness pull request: 2 watermarked commit(s) and the description ending with'],
  },
  {
    n: 17, name: 'watermarked commits under a description without the watermark fail',
    run: (root) => { const r = repo(root); stage(r.work); helper(r.work, ['feat: one']); return gate(r, root, 'Adds a thing.'); },
    exit: 1, includes: ['its commits carry the watermark, so the description must end with it'],
  },
  {
    n: 18, name: "a person's unwatermarked commit in a harness pull request passes untouched — a reviewer's fix needs no watermark",
    run: (root) => { const r = repo(root); stage(r.work); helper(r.work, ['feat: one']); byHand(r.work, 'fix: a reviewer\'s fix\n'); return gate(r, root, `Adds things.\n\n${W}`); },
    exit: 0, includes: ["WATERMARK OK — a harness pull request: 1 watermarked commit(s) and 1 person's commit(s), passed untouched,"],
  },
  {
    n: 35, name: 'a watermarked description with no watermarked commit fails — a harness pull request holds at least one harness commit',
    run: (root) => { const r = repo(root); byHand(r.work, 'fix: one\n'); byHand(r.work, 'fix: two\n'); return gate(r, root, `Two fixes.\n\n${W}`); },
    exit: 1, includes: ['carries the watermark, and none of its 2 non-merge commit(s) does'],
  },
  {
    n: 36, name: 'a malformed watermark claim on a commit still fails in a harness pull request',
    run: (root) => { const r = repo(root); stage(r.work); helper(r.work, ['feat: one']); byHand(r.work, 'feat: two\n\nGenerated by SHL Agentic Harness\n'); return gate(r, root, `Two things.\n\n${W}`); },
    exit: 1, includes: ['is a modified watermark', 'WATERMARK FAILED — 1 finding(s)'],
  },
  {
    n: 19, name: "a person's pull request — no watermarked commit, no watermark in the description — passes unchanged",
    run: (root) => { const r = repo(root); byHand(r.work, 'fix: one\n'); byHand(r.work, 'fix: two\n'); return gate(r, root, 'Two fixes.'); },
    exit: 0, includes: ["WATERMARK OK — a person's pull request"],
  },
  {
    n: 20, name: 'a description whose watermark is misplaced, modified or hidden fails',
    run: (root) => {
      const r = repo(root);
      stage(r.work);
      helper(r.work, ['feat: one']);
      const bad = [`${W}\n\nMore after it.`, `Summary.\n\n${W}.`, `Summary.\n\n\`\`\`\n${W}\n\`\`\``, `Summary.\n\n<!-- ${W} -->`, `Summary.\n\n- ${W}`, `Summary.\n${W}`];
      const accepted = bad.filter((b) => gate(r, root, b).status !== 1);
      return { status: accepted.length ? 0 : 1, output: accepted.length ? `accepted: ${JSON.stringify(accepted)}` : `all ${bad.length} refused` };
    },
    exit: 1, includes: ['all 6 refused'],
  },
  {
    n: 21, name: "a person's merge commit inside a harness pull request is not read; the harness commits are",
    run: (root) => {
      const r = repo(root);
      git(r.work, ['checkout', '-q', '-b', 'side']);
      stage(r.work);
      helper(r.work, ['feat: on the side']);
      git(r.work, ['checkout', '-q', 'main']);
      stage(r.work);
      helper(r.work, ['feat: on main']);
      git(r.work, ['merge', '-q', '--no-ff', '-m', 'Merge side', 'side']);
      return gate(r, root, `Both.\n\n${W}`);
    },
    exit: 0, includes: ['2 watermarked commit(s) and the description'],
  },
  {
    n: 22, name: '--no-verify gets a malformed harness commit past the local hook, and the pull-request check catches it',
    run: (root) => {
      const r = repo(root);
      spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      stage(r.work);
      helper(r.work, ['feat: one']);
      const blocked = byHand(r.work, `feat: two\n\n${W}.\n`);
      if (blocked.status === 0) return { status: 99, output: 'the hook did not block' };
      const bypassed = spawn(r.work, 'git', ['commit', '-q', '--no-verify', '-F', '-'], {}, `feat: two\n\n${W}.\n`);
      if (bypassed.status !== 0) return { status: 98, output: bypassed.output };
      return gate(r, root, `Two things.\n\n${W}`);
    },
    exit: 1, includes: ['is a modified watermark', 'WATERMARK FAILED'],
  },
  {
    n: 23, name: 'no description file is cannot verify; a shallow clone is cannot verify; a malformed range is usage',
    run: (root) => {
      const r = repo(root);
      stage(r.work);
      helper(r.work, ['feat: one']);
      const a = spawn(r.work, process.execPath, [CHECK, '--pr-body', join(root, 'absent.md'), `${r.base}..HEAD`]).status;
      const shallow = join(root, 'shallow');
      git(root, ['clone', '-q', '--depth', '1', `file://${r.work}`, shallow]);
      writeFileSync(join(root, 'b.md'), `${W}\n`);
      const b = spawn(shallow, process.execPath, [CHECK, '--pr-body', join(root, 'b.md'), 'HEAD~1..HEAD']).status;
      const c = spawn(r.work, process.execPath, [CHECK, '--pr-body', join(root, 'b.md'), 'HEAD']).status;
      return { status: 0, output: `absent=${a} shallow=${b} range=${c}` };
    },
    exit: 0, includes: ['absent=2 shallow=2 range=3'],
  },

  /* ------------------------------------------------- every path, and the two workflows */
  {
    n: 24, name: 'every harness commit path commits through harness-commit.mjs, and none carries a raw git commit; /dev-spec and /dev-sprint install the check in the checkouts they make',
    run: () => {
      const p = [];
      for (const rel of COMMIT_FILES) {
        const text = read(rel);
        if (text === null) { p.push(`${rel} is missing`); continue; }
        if (!text.includes('harness-commit.mjs')) p.push(`${rel} does not commit through harness-commit.mjs`);
        const raw = text.split('\n').find((l) => RAW_COMMIT.test(l));
        if (raw) p.push(`${rel} still carries a raw git commit: ${raw.trim()}`);
      }
      const spec = read(L('accelerator/commands/dev-spec.md', '.claude/commands/dev-spec.md')) || '';
      const sprint = read(L('accelerator/commands/dev-sprint.md', '.claude/commands/dev-sprint.md')) || '';
      if (spec.search(/^node scripts\/harness-commit\.mjs --install-hook "\.worktrees\/<KEY>\/hub" --worktree$/m) < 0) p.push('dev-spec.md does not install the check in the hub checkout');
      // /dev-sprint runs in .worktrees/<KEY>/hub, so the code checkout beside it is ../<REPO-ID>.
      if (sprint.search(/^node scripts\/harness-commit\.mjs --install-hook "\.\.\/<REPO-ID>"$/m) < 0) p.push('dev-sprint.md does not install the check in the code checkout');
      return { status: p.length ? 1 : 0, output: p.join('\n') || `all ${COMMIT_FILES.length} files commit through the helper; /dev-spec and /dev-sprint install the check` };
    },
    exit: 0, includes: ['commit through the helper'],
  },
  {
    n: 25, library: true, name: 'the hub and spoke installation commit through the helper, and scripts/upgrade.mjs commits only through it',
    run: () => {
      const p = [];
      for (const rel of INSTALL_FILES) if (!(read(rel) || '').includes('harness-commit.mjs')) p.push(`${rel} does not commit through harness-commit.mjs`);
      const up = read('scripts/upgrade.mjs') || '';
      if (!/import \{[^}]*harnessCommit[^}]*\} from '\.\.\/accelerator\/gate\/harness-commit\.mjs'/.test(up)) p.push('upgrade.mjs does not import the helper');
      if (/'commit', '--quiet'/.test(up) || /gitAt\([^)]*'commit'/.test(up)) p.push('upgrade.mjs still runs git commit itself');
      // The definition, then the three commit sites: the hub's worktree, the spoke's clone, and the
      // global repository's receipt on its install branch (--adopt --global --on-branch).
      if ((up.match(/watermarkedCommit\(/g) || []).length !== 4) p.push('upgrade.mjs does not route its three commit sites (hub, spoke and the global receipt) through the helper');
      return { status: p.length ? 1 : 0, output: p.join('\n') || 'installation and upgrade commit through the helper' };
    },
    exit: 0, includes: ['installation and upgrade commit through the helper'],
  },
  {
    n: 26, name: 'every harness pull-request path ends its description with the watermark',
    run: () => {
      const p = PR_FILES.filter((rel) => !(read(rel) || '').includes(W)).map((rel) => `${rel} does not end its pull request description with the watermark`);
      if (LIBRARY) {
        for (const rel of [...INSTALL_FILES, 'onboard/references/upgrade-estate.md']) if (!(read(rel) || '').includes(W)) p.push(`${rel} does not end its pull request description with the watermark`);
        if (((read('scripts/upgrade.mjs') || '').match(/\$\{WATERMARK\}\\n--- end ---/g) || []).length !== 2) p.push('upgrade.mjs does not end both printed pull request bodies with the watermark');
      }
      return { status: p.length ? 1 : 0, output: p.join('\n') || 'every pull-request path ends its description with the watermark' };
    },
    exit: 0, includes: ['every pull-request path ends its description with the watermark'],
  },
  {
    n: 27, name: 'the required gates run the check on every pull request — after earlier failures, again when the description is edited — with the description from the event and the checker from protected content',
    run: () => {
      const blocks = [];
      if (LIBRARY) {
        blocks.push(['story-gate.workflow.yml', read('accelerator/spoke/story-gate.workflow.yml'), 'node hub/scripts/check-watermark.mjs --pr-body "$RUNNER_TEMP/pr-body.md" "$BASE_SHA..$HEAD_SHA"']);
        blocks.push(['design-gate.yml', read('accelerator/hub/workflows/design-gate.yml'), 'node "$checker" --pr-body "$RUNNER_TEMP/pr-body.md" "$BASE_SHA..$HEAD_SHA"']);
      } else {
        blocks.push(['design-gate.yml', read('.github/workflows/design-gate.yml'), 'node "$checker" --pr-body "$RUNNER_TEMP/pr-body.md" "$BASE_SHA..$HEAD_SHA"']);
      }
      const p = [];
      for (const [label, text, call] of blocks) {
        if (!text) { p.push(`${label} is missing`); continue; }
        // story-gate also runs on `closed`, for its observability-signal job only: its checks skip a close.
        if (text.search(/types: \[opened, synchronize, reopened, edited(, closed)?\]/) < 0) p.push(`${label} does not re-run when the description is edited`);
        const lines = text.split('\n');
        const at = lines.findIndex((l) => l.includes(' --pr-body "$RUNNER_TEMP/pr-body.md"'));
        if (at < 0) { p.push(`${label} never runs the watermark check`); continue; }
        if (!lines[at].includes(call)) p.push(`${label} runs the check otherwise: ${lines[at].trim()}`);
        const step = lines.slice(0, at).map((l, i) => [l, i]).filter(([l]) => /^\s*- (name|uses):/.test(l)).pop();
        const body = lines.slice(step ? step[1] : 0, at + 1);
        const ifs = body.filter((l) => /^\s*if:/.test(l)).map((l) => l.trim().replace(/\s+#.*$/, ''));
        // story-gate runs the step where its plan says so; the plan's flag joins !cancelled(), never replaces it.
        const want = label.startsWith('story-gate') ? "if: ${{ !cancelled() && env.RUN_WATERMARK == '1' }}" : 'if: ${{ !cancelled() }}';
        if (ifs.length !== 1 || ifs[0] !== want) p.push(`${label}'s watermark step does not run after earlier failures (if: ${JSON.stringify(ifs)})`);
        if (!body.some((l) => l.includes('PR_BODY: ${{ github.event.pull_request.body }}'))) p.push(`${label} does not read the description from the pull-request event`);
        if (!body.some((l) => l.includes('set -euo pipefail'))) p.push(`${label}'s watermark step does not run under set -euo pipefail`);
        if (/continue-on-error|\|\| true/.test(body.join('\n'))) p.push(`${label}'s watermark step can be made to pass`);
        if (label.startsWith('story-gate')) {
          if (!body.some((l) => l.includes('[ -f hub/scripts/check-watermark.mjs ] ||') && l.includes('exit 2'))) p.push('story-gate does not stop with exit 2 when the hub has no checker yet');
          const hubCheckout = lines.findIndex((l) => l.includes('# the hub, read-only'));
          // story-gate clones the hub wherever a hub is known: HUB_REPO is empty only when checks.env at the base names none.
          if (hubCheckout < 0 || !lines[hubCheckout + 1].includes("if: ${{ !cancelled() && env.HUB_REPO != '' }}")) p.push('story-gate skips the hub clone after an earlier failure, so the watermark step has no checker');
        } else {
          if (!body.some((l) => l.includes('git show "$BASE_SHA:scripts/check-watermark.mjs" > "$checker"'))) p.push('design-gate does not take the checker from the base commit');
          const design = lines.findIndex((l) => l.includes('- name: Validate the designs changed in this pull request'));
          if (design < 0 || design > (step ? step[1] : 0)) p.push('design-gate runs the watermark step before the design step');
        }
      }
      return { status: p.length ? 1 : 0, output: p.join('\n') || `${blocks.length} required gate(s) run the watermark check from the event` };
    },
    exit: 0, includes: ['run the watermark check from the event'],
  },
  {
    n: 28, library: true, name: 'no key or signature infrastructure and no per-agent provenance anywhere in the tracked files of the library',
    run: () => {
      // The library tree only. A hub's tree also holds the team's own text (designs, drafts, the
      // ledger), which can name these words for its own services and would block every upgrade.
      const banned = ['signing' + 'key', 'agent' + '-signers', 'allowedSigners' + 'File', 'verify' + '-commit', 'commit' + '_identity', 'Harness' + '-Agent', 'pull_request' + '_target', 'ssh' + '-keygen', 'gpg' + '.format'];
      const keyMaterial = new RegExp('-----BEGIN [A-Z0-9 ]*' + 'PRIVATE KEY-----');
      const files = git(ROOT, ['ls-files', '-z']).split('\0').filter((f) => f && existsSync(join(ROOT, f)));
      const hits = [];
      for (const f of files) {
        const text = readFileSync(join(ROOT, f), 'latin1');
        for (const b of banned) if (text.includes(b)) hits.push(`${f}: ${b}`);
        if (keyMaterial.test(text)) hits.push(`${f}: private key material`);
      }
      return { status: hits.length ? 1 : 0, output: hits.length ? hits.join('\n') : `no private key material and none of ${banned.length} key, signature or per-agent markers in ${files.length} tracked files` };
    },
    exit: 0, includes: ['key, signature or per-agent markers in'],
  },
  /* ------------------------------------------------------ the review's findings */
  {
    n: 29, name: 'git --cleanup=whitespace keeps comment lines, so a "# note" after the watermark would be stored last — the hook rewrites the message and the stored final line is the watermark',
    run: (root) => {
      const r = repo(root);
      spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      stage(r.work);
      const made = spawn(r.work, 'git', ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { HARNESS_COMMIT: '1' }, `feat: x\n\n${W}\n# a note git would keep\n`);
      const last = git(r.work, ['log', '-1', '--format=%B']).trimEnd().split('\n').pop();
      return { status: made.status, output: `${made.output}stored last line: ${JSON.stringify(last)}` };
    },
    exit: 0, includes: [`stored last line: ${JSON.stringify(W)}`],
  },
  {
    n: 30, name: "--install-hook chains to the hooks already in force: the team's pre-commit and commit-msg keep running after the watermark check",
    run: (root) => {
      const r = repo(root);
      const team = join(root, 'team-hooks');
      writeFiles(team, {
        'pre-commit': `#!/bin/sh\ntouch '${join(root, 'pre-commit-ran')}'\n`,
        'commit-msg': '#!/bin/sh\ngrep -q BAD "$1" && { echo "team lint: BAD"; exit 1; }\nexit 0\n',
      });
      git(r.work, ['config', 'core.hooksPath', team]);
      const installed = spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      const again = spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      stage(r.work);
      const viaHelper = helper(r.work, ['feat: through the helper']).status;
      const preRan = existsSync(join(root, 'pre-commit-ran'));
      const teamLint = byHand(r.work, 'fix: BAD wording\n');
      const ours = byHand(r.work, `feat: x\n\n- ${W}\n`);
      return { status: 0, output: `${installed.output}${again.output}helper=${viaHelper} pre-commit-ran=${preRan} team-lint=${teamLint.status} ours=${ours.status}\n${teamLint.output}${ours.output}` };
    },
    exit: 0, includes: ['then this checkout\'s own hooks in', 'team-hooks', 'helper=0 pre-commit-ran=true team-lint=1 ours=1', 'team lint: BAD', 'WATERMARK FAILED'],
  },
  {
    n: 31, name: "with no core.hooksPath, --install-hook chains to the checkout's own .git/hooks",
    run: (root) => {
      const r = repo(root);
      writeFiles(join(r.work, '.git', 'hooks'), { 'pre-commit': `#!/bin/sh\ntouch '${join(root, 'default-ran')}'\n` });
      spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      byHand(r.work, 'fix: by hand\n');
      return { status: existsSync(join(root, 'default-ran')) ? 0 : 1, output: existsSync(join(root, 'default-ran')) ? 'the .git/hooks pre-commit ran' : 'the .git/hooks pre-commit did not run' };
    },
    exit: 0, includes: ['the .git/hooks pre-commit ran'],
  },
  {
    n: 32, name: 'when something later replaces core.hooksPath (husky install), the helper says the watermark hook no longer runs',
    run: (root) => {
      const r = repo(root);
      spawn(r.work, process.execPath, [COMMIT, '--install-hook', '.']);
      git(r.work, ['config', 'core.hooksPath', '.husky']);
      stage(r.work);
      return helper(r.work, ['feat: after husky']);
    },
    exit: 0, includes: ['WARNING — the watermark hook installed in this checkout no longer runs: core.hooksPath now points at', '.husky', 'HARNESS COMMIT'],
  },
  {
    n: 33, name: "the helper refuses a message line that starts with git's comment character, which the check would drop",
    run: (root) => { const r = repo(root); stage(r.work); return helper(r.work, ['feat: x', '#123 is the issue']); },
    exit: 3, includes: ['starts with "#", git\'s comment character'],
  },
  {
    n: 37, library: true, name: "the watermark's scope is the installed estate: the library's own CI never checks the library's commits, no hook is configured here, and the rule says so",
    run: () => {
      const p = [];
      // CI runs every target the Makefile lists, one matrix job each, so the suite is in CI
      // when CI reads that list and the Makefile runs the suite.
      const ci = read('.github/workflows/ci.yml') || '';
      const makefile = read('Makefile') || '';
      if (!ci.includes('node scripts/check-all.mjs --list') || !ci.includes('make ${{ matrix.target }}')) p.push('ci.yml does not run the targets the Makefile lists');
      if (!/^test-watermark:.*## [^\n]*\n\t@node accelerator\/gate\/tests\/check-watermark\/run\.mjs$/m.test(makefile)) p.push('the Makefile has no listed target that runs the watermark fixture suite');
      for (const [name, text] of [['ci.yml', ci], ['Makefile', makefile]]) {
        for (const line of text.split('\n')) {
          if (/check-watermark\.mjs\s+--(pr-body|commit-msg)/.test(line)) p.push(`${name} checks the library's own history: ${line.trim()}`);
        }
      }
      const hook = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' });
      if (hook.status === 0) p.push(`the library checkout has core.hooksPath=${hook.stdout.trim()} configured; the watermark hook belongs in installed checkouts only`);
      const rule = read(L('accelerator/rules/watermark.md', '.claude/rules/watermark.md')) || '';
      if (!/library repository[^.]*is not watermarked/.test(rule)) p.push('the rule does not state that the library repository is not watermarked');
      if (!rule.includes('installed harness')) p.push('the rule does not scope the watermark to the installed harness');
      return { status: p.length ? 1 : 0, output: p.join('\n') || "scope pinned: the suite judges installed behaviour in throwaway repositories; the library's own commits are ordinary" };
    },
    exit: 0, includes: ['scope pinned'],
  },
];

/* ---------------------------------------------------------------------- runner */

function main() {
  const wanted = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const selected = wanted.length ? FIXTURES.filter((f) => wanted.includes(f.n)) : FIXTURES;
  process.stdout.write(`scripts under test: ${CHECK}, ${COMMIT} (${LIBRARY ? 'library' : 'installed'} layout)\n${selected.length} of ${FIXTURES.length} fixtures\n\n`);
  let failed = 0;
  let skipped = 0;
  for (const f of selected) {
    if (f.library && !LIBRARY) { skipped += 1; process.stdout.write(`  SKIP  ${f.n}. ${f.name} — library layout only\n`); continue; }
    const root = mkdtempSync(join(tmpdir(), `watermark-fx${String(f.n).padStart(2, '0')}-`));
    let res;
    try { res = f.run(root); } catch (err) { res = { status: 'threw', output: err && err.stack ? err.stack : String(err) }; }
    const problems = [];
    if (res.status !== f.exit) problems.push(`expected exit ${f.exit}, got ${res.status}`);
    for (const n of f.includes || []) if (!res.output.includes(n)) problems.push(`output does not contain: ${n}`);
    for (const n of f.excludes || []) if (res.output.includes(n)) problems.push(`output should not contain: ${n}`);
    if (problems.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${f.n}. ${f.name} [exit ${f.exit}]\n${problems.map((p) => `          - ${p}`).join('\n')}\n${res.output.split('\n').map((l) => `          | ${l}`).join('\n')}\n`);
    } else {
      process.stdout.write(`  PASS  ${f.n}. ${f.name} [exit ${f.exit}]\n`);
    }
    if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
  const ran = selected.length - skipped;
  process.stdout.write(failed ? `\n${failed} of ${ran} fixtures FAILED.\n` : `\nAll ${ran} fixtures passed${skipped ? ` (${skipped} skipped: library layout only)` : ''}.\n`);
  rmSync(SANDBOX_HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();

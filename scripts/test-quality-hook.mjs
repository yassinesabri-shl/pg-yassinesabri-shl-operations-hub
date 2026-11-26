#!/usr/bin/env node
// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15
/**
 * test-quality-hook.mjs — Claude Code PreToolUse hook on the Agent tool: at every launch of the
 * critic in `test-review` mode, run the test-quality scan and add its findings to the critic's
 * prompt, so the critic reviews the tests knowing them and answers the test writer once.
 *
 * Registered in the hub's .claude/settings.json (accelerator/settings/test-quality-hook.settings.json).
 * A dispatch it does not concern passes untouched: another tool, another seat, another mode.
 * `/dev-sprint` step 3 hands the critic two lines the hook reads:
 *
 *     Mode: test-review
 *     Test-Checkout: <absolute path>      the test writer's checkout
 *     Test-Base: <the trunk commit /worktree cut the branch from>
 *
 * A relative Test-Checkout is read from the hub root (CLAUDE_PROJECT_DIR), never from the folder the
 * session works in: `/dev-sprint` works in `.worktrees/<KEY>/hub`, so it gives the absolute path.
 *
 * Each of the three starts a line. The Mode line may go on after the mode, as a controller writes
 * it with the cycle and the seat: `Mode: test-review. Cycle: 1 of 3`. A longer mode name is another mode.
 *
 * It scans `Test-Base..HEAD` of that checkout with the rules and the pin of the hub's committed
 * HEAD (test-quality-scan.mjs): every launch is a fresh scan, so a revision is scanned again.
 *
 * It never blocks. Where Semgrep is missing, the wrong version, or the scan cannot run for any
 * reason, the user sees a warning and the critic is told "Semgrep scan not run" and reviews on.
 * It decides nothing about permissions: it only rewrites the prompt. Always exit 0, whatever
 * happens. Node standard library only.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, scan } from './test-quality-scan.mjs';

const SEATS = new Set(['dual-mode-critic']);
const TOOLS = new Set(['Agent', 'Task']);
// Under the 120 s the settings entry allows, so a slow scan ends in the "not run" note and warning, never in a hook that was killed silently.
const SCAN_TIMEOUT_MS = 100 * 1000;

/** The value of a `Name: value` line of the dispatch, or null. */
const field = (prompt, name) => {
  for (const line of prompt.split('\n')) {
    if (line.startsWith(`${name}:`)) return line.slice(name.length + 1).trim() || null;
  }
  return null;
};

const USE = [
  'How to use this scan, which the harness ran for you before this review:',
  '- Every VIOLATION is a finding in your reply — id SG-<n>, severity IMPORTANT, with its location and the rule\'s fix — and while one stands your verdict is CHANGES REQUESTED, never APPROVED.',
  '- Each WARNING is uncertain: confirm it as a finding, or dismiss it with a one-line reason.',
  '- A NOT COVERED file was not checked at all: review it by hand.',
  '- Return the scan\'s findings and your own to the test writer in ONE findings table.',
].join('\n');

/** What the critic is told and what the user sees for this dispatch. */
function judge(prompt, hub) {
  const notRun = (why) => ({
    note: `## STATIC SCAN — Semgrep scan not run\n\nSemgrep scan not run: ${why}\nNothing was checked by the scan for this review. Open your reply with the line above, word for word: the orchestrator relays it to the person, and never sees the warning the hook showed. Then say so in your reply and review the tests as usual.\n`,
    message: `⚠ test-quality: Semgrep scan not run — ${why}. The critic was told and the review continues without it.`,
  });
  const checkout = field(prompt, 'Test-Checkout');
  const base = field(prompt, 'Test-Base');
  if (!checkout || !base) return notRun(`the dispatch carries no ${checkout ? 'Test-Base' : 'Test-Checkout'} line, so there is nothing to scan`);
  const result = scan({ repo: isAbsolute(checkout) ? checkout : join(hub, checkout), range: `${base}..HEAD`, hub, timeoutMs: SCAN_TIMEOUT_MS });
  if (result.code !== EXIT.PASS && result.code !== EXIT.VIOLATIONS) return notRun(String(result.why || result.report).trim());
  const report = result.report.trim();
  return { note: `## STATIC SCAN — Semgrep CE\n\n${report}\n\n${USE}\n`, message: `test-quality: ${report.split('\n').pop()} Added to the critic's prompt.` };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw);
      const input = event.tool_input || {};
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (!TOOLS.has(event.tool_name) || !SEATS.has(input.subagent_type) || prompt.search(/^Mode:[ \t]*test-review(?![\w-])/m) === -1) return;
      const { note, message } = judge(prompt, process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd());
      process.stdout.write(`${JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, prompt: `${prompt.replace(/\s+$/, '')}\n\n${note}` } },
      })}\n`);
    } catch (err) {
      // Never block a review because the hook failed: warn, and carry on.
      process.stdout.write(`${JSON.stringify({ systemMessage: `⚠ test-quality: Semgrep scan not run — the hook failed (${err.message}). The review continues without it.` })}\n`);
    }
  });
}

const invoked = (() => { try { return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); } catch (err) { return false; } })();
if (invoked) main();

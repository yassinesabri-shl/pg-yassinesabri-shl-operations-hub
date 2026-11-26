/**
 * common.mjs — the protected-test guard's constants, errors and output, shared by every module.
 */

export const EXIT = { PASS: 0, FAIL: 1, CANNOT_VERIFY: 2, USAGE: 3, INTERNAL: 4 };
export const GUARD_KEY = 'TEST_GUARD_PATHS';
// Retired: the engineer adds no test. A checks.env that still sets it is refused, never ignored.
export const RETIRED_KEY = 'TEST_WRITABLE_PATHS';
export const REF_ROOT = 'refs/harness/test-guard';
export const RUN_PREFIX = 'harness-test-guard-';
export const PR_LINE = 'Protected-test guard:';
export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
export const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const CONTINUING = 'Your session is continuing.';
export const NEXT_STEP = 'Tests are owned by the test writer. Continue with production code, or send the orchestrator a test-change request.';
/** Tool-call and session ids that start with this are the preflight's, never the engineer's. */
export const HANDSHAKE = 'harness-test-guard-handshake-';
export const isHandshake = (...ids) => ids.some((v) => typeof v === 'string' && v.startsWith(HANDSHAKE));

export class GuardError extends Error {
  constructor(exit, message, reason = null) { super(message); this.exit = exit; this.reason = reason; }
}
export const cannot = (message, reason = null) => new GuardError(EXIT.CANNOT_VERIFY, message, reason);
export const usageError = (message) => new GuardError(EXIT.USAGE, message);

export const out = (line = '') => process.stdout.write(`${line}\n`);
export const short = (sha) => String(sha).slice(0, 12);
export const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

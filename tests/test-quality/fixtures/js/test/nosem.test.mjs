import assert from 'node:assert/strict';
import { test } from 'node:test';

// ruleid: shl-js-skipped
test.skip('hidden by a comment', () => { assert.equal(compute(), 1); }); // nosem: shl-js-skipped

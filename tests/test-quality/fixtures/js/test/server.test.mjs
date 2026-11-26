import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

// ok: node:test with node:assert, asserting inside a helper's callback
test('GET /status returns 200', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
  });
});

// ok: the error is named
test('rejects a bad port', () => {
  assert.throws(() => createApp({ port: -1 }), RangeError);
});

// ruleid: shl-js-skipped
test('is skipped by option', { skip: true }, async () => {
  assert.equal(createApp.length, 1);
});

// ruleid: shl-js-skipped
test('is a to-do by option', { todo: 'later' }, () => {
  assert.ok(createApp);
});

test('any error', () => {
  // ruleid: shl-js-broad-error
  assert.throws(() => createApp({ port: -1 }));
  // ruleid: shl-js-tautology
  assert.equal(1, 1);
  // ruleid: shl-js-tautology
  assert.ok(true);
});

// ok: this one is not skipped (skip: false)
test('explicitly not skipped', { skip: false }, () => {
  assert.equal(createApp.name, 'createApp');
});

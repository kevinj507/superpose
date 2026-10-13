// Constitution: a product the shop does not sell has no page and cannot be
// bought. The constitution's files belong to the owner; no task changes them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.js';

test('an unknown product has no page', async () => {
  const res = await handle({ method: 'GET', path: '/products/spaceship' });
  assert.equal(res.status, 404);
});

test('an unknown product cannot be bought', async () => {
  const res = await handle({ method: 'POST', path: '/products/spaceship/buy' });
  assert.equal(res.status, 404);
  const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  assert.equal(body.ok, false);
});

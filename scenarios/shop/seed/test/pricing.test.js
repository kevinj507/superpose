import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceOf } from '../src/pricing.js';

test('a product costs its base price', () => {
  assert.equal(priceOf('lamp'), 40);
  assert.equal(priceOf('mug'), 12.5);
  assert.equal(priceOf('blanket'), 65);
});

test('priceOf refuses a product the shop does not sell', () => {
  assert.throws(() => priceOf('spaceship'), /no such product/);
});

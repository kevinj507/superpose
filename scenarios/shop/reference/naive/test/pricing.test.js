import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { priceOf, recordPurchase, resetPrices } from '../src/pricing.js';

beforeEach(() => resetPrices());

test('before anything is sold, a product costs its base price', () => {
  assert.equal(priceOf('lamp'), 40);
  assert.equal(priceOf('mug'), 12.5);
  assert.equal(priceOf('blanket'), 65);
});

test('each purchase raises the price by 5%, compounding', () => {
  recordPurchase('lamp');
  assert.equal(priceOf('lamp'), 42);
  recordPurchase('lamp');
  assert.equal(priceOf('lamp'), 44.1);
  recordPurchase('lamp');
  assert.equal(priceOf('lamp'), 46.31);
});

test('recordPurchase returns the new price, rounded to the cent', () => {
  assert.equal(recordPurchase('mug'), 13.13);
  assert.equal(priceOf('mug'), 13.13);
});

test('after many purchases the price is still whole cents, about 5% compounded', () => {
  for (let i = 0; i < 10; i++) recordPurchase('lamp');
  const price = priceOf('lamp');
  assert.equal(Math.round(price * 100) / 100, price);
  assert.ok(Math.abs(price - 40 * 1.05 ** 10) < 0.05, `${price} is about ${40 * 1.05 ** 10}`);
});

test('a purchase moves only that product\'s price', () => {
  recordPurchase('lamp');
  assert.equal(priceOf('mug'), 12.5);
  assert.equal(priceOf('blanket'), 65);
});

test('resetPrices puts every product back at its base price', () => {
  recordPurchase('lamp');
  recordPurchase('mug');
  resetPrices();
  assert.equal(priceOf('lamp'), 40);
  assert.equal(priceOf('mug'), 12.5);
});

test('unknown products are refused', () => {
  assert.throws(() => priceOf('spaceship'), /no such product/);
  assert.throws(() => recordPurchase('spaceship'), /no such product/);
});

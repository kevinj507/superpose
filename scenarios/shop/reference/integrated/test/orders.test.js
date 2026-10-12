import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { buy, orderHistory, resetOrders } from '../src/orders.js';
import { priceOf, resetPrices } from '../src/pricing.js';

beforeEach(() => {
  resetOrders();
  resetPrices();
});

test('buy returns the product and the price paid', () => {
  assert.deepEqual(buy('lamp'), { ok: true, product: 'lamp', price: 40 });
});

test('the next buyer pays the new price', () => {
  const paid = [buy('lamp'), buy('lamp'), buy('lamp')].map((r) => r.price);
  assert.deepEqual(paid, [40, 42, 44.1]);
  assert.equal(priceOf('lamp'), 46.31);
});

test('a purchase moves only that product\'s price', () => {
  buy('lamp');
  buy('lamp');
  assert.equal(buy('mug').price, 12.5);
  assert.equal(priceOf('blanket'), 65);
});

test('the order history keeps what each buyer paid, oldest first', () => {
  buy('lamp');
  buy('mug');
  buy('lamp');
  assert.deepEqual(orderHistory(), [
    { product: 'lamp', price: 40 },
    { product: 'mug', price: 12.5 },
    { product: 'lamp', price: 42 },
  ]);
});

test('buying something the shop does not sell is refused, recorded nowhere, and moves no price', () => {
  const result = buy('spaceship');
  assert.equal(result.ok, false);
  assert.match(result.error, /no such product/);
  assert.deepEqual(orderHistory(), []);
  assert.equal(priceOf('lamp'), 40);
});

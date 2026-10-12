import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { buy, orderHistory, resetOrders } from '../src/orders.js';

beforeEach(() => resetOrders());

test('buy returns the product and the price paid', () => {
  assert.deepEqual(buy('lamp'), { ok: true, product: 'lamp', price: 40 });
});

test('the order history remembers every purchase, oldest first', () => {
  buy('lamp');
  buy('mug');
  assert.deepEqual(orderHistory(), [
    { product: 'lamp', price: 40 },
    { product: 'mug', price: 12.5 },
  ]);
});

test('buying something the shop does not sell is refused and not recorded', () => {
  const result = buy('spaceship');
  assert.equal(result.ok, false);
  assert.match(result.error, /no such product/);
  assert.deepEqual(orderHistory(), []);
});

// Constitution: every purchase says what the buyer paid. The constitution's
// files belong to the owner; no task changes them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.js';
import { products } from '../src/catalog.js';

test('a purchase answers with ok, the product and the price paid', async () => {
  for (const product of products) {
    const res = await handle({ method: 'POST', path: `/products/${product.id}/buy` });
    assert.equal(res.status, 200, `buying ${product.id}`);
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    assert.equal(body.ok, true, `buying ${product.id}`);
    assert.equal(body.product, product.id);
    assert.equal(typeof body.price, 'number', `the price paid for ${product.id} is a number`);
    assert.ok(body.price > 0, `the price paid for ${product.id} is positive`);
  }
});

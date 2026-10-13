// Constitution: every product page shows the product's name and its price,
// in dollars and cents inside <span class="price">. The constitution's files
// belong to the owner; no task changes them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.js';
import { products } from '../src/catalog.js';

test('every product page shows the name and a price like $40.00', async () => {
  for (const product of products) {
    const res = await handle({ method: 'GET', path: `/products/${product.id}` });
    assert.equal(res.status, 200, `the page for ${product.id}`);
    const html = String(await res.body);
    assert.ok(html.includes(product.name), `the page for ${product.id} names it`);
    const price = html.match(/<span class="price">([^<]*)<\/span>/);
    assert.ok(price, `the page for ${product.id} shows a price inside <span class="price">`);
    assert.match(price[1], /^\$\d+\.\d{2}$/, `the price for ${product.id} is dollars and cents`);
  }
});

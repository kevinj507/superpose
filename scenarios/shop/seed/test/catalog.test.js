import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findProduct, products } from '../src/catalog.js';

test('every product has a unique id, a name and a base price', () => {
  assert.ok(products.length >= 3);
  for (const product of products) {
    assert.match(product.id, /^[a-z0-9-]+$/);
    assert.equal(typeof product.name, 'string');
    assert.ok(product.basePrice > 0, `${product.id} has a positive base price`);
  }
  assert.equal(new Set(products.map((p) => p.id)).size, products.length);
});

test('findProduct finds a product by its id', () => {
  assert.deepEqual(findProduct('lamp'), { id: 'lamp', name: 'Desk lamp', basePrice: 40 });
  assert.equal(findProduct('mug').basePrice, 12.5);
});

test('findProduct gives null for anything the shop does not sell', () => {
  assert.equal(findProduct('spaceship'), null);
  assert.equal(findProduct(undefined), null);
});

test('the catalog cannot be changed by accident', () => {
  assert.throws(() => {
    products[0].basePrice = 1;
  }, TypeError);
  assert.equal(findProduct('lamp').basePrice, 40);
});

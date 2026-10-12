import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productPage } from '../src/pages.js';

test('a product page shows its name and its price', () => {
  const html = productPage('lamp');
  assert.match(html, /<h1>Desk lamp<\/h1>/);
  assert.match(html, /<span class="price">\$40\.00<\/span>/);
});

test('each product has its own page', () => {
  assert.match(productPage('mug'), /<span class="price">\$12\.50<\/span>/);
});

test('there is no page for a product the shop does not sell', () => {
  assert.equal(productPage('spaceship'), null);
});

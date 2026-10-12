import assert from 'node:assert/strict';
import { test } from 'node:test';
import { products } from '../src/catalog.js';
import { homePage } from '../src/home.js';

test('the home page is the shop\'s front page', () => {
  const html = homePage();
  assert.match(html, /<title>Tiny Shop<\/title>/);
  assert.match(html, /<h1>Tiny Shop<\/h1>/);
});

test('the home page lists every product with a link to its page and its price', () => {
  const html = homePage();
  assert.match(html, /<li><a href="\/products\/lamp">Desk lamp<\/a> <span class="price">\$40\.00<\/span><\/li>/);
  assert.match(html, /<li><a href="\/products\/mug">Coffee mug<\/a> <span class="price">\$12\.50<\/span><\/li>/);
  assert.match(html, /<li><a href="\/products\/blanket">Wool blanket<\/a> <span class="price">\$65\.00<\/span><\/li>/);
});

test('products are listed in catalog order', () => {
  const html = homePage();
  const listed = [...html.matchAll(/href="\/products\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, products.map((p) => p.id));
});

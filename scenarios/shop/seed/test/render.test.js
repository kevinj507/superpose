import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, formatPrice, layout, renderProduct } from '../src/render.js';

test('formatPrice shows dollars and cents', () => {
  assert.equal(formatPrice(40), '$40.00');
  assert.equal(formatPrice(12.5), '$12.50');
  assert.equal(formatPrice(44.1), '$44.10');
});

test('escapeHtml makes text safe to put in a page', () => {
  assert.equal(escapeHtml('<b>"Tom" & \'Jerry\'</b>'), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
});

test('layout wraps content in a whole page with a title', () => {
  const html = layout('Hello <world>', '<p>hi</p>');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Hello &lt;world&gt;<\/title>/);
  assert.match(html, /<p>hi<\/p>/);
});

test('a product page shows the name, the price in span.price and a buy button', () => {
  const html = renderProduct({ product: { id: 'lamp', name: 'Desk lamp' }, price: 40 });
  assert.match(html, /<title>Desk lamp \| Tiny Shop<\/title>/);
  assert.match(html, /<h1>Desk lamp<\/h1>/);
  assert.match(html, /<span class="price">\$40\.00<\/span>/);
  assert.match(html, /<form method="post" action="\/products\/lamp\/buy">/);
});

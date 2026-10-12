import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderProduct } from '../src/render.js';
import { PAGE_TTL_MS, createProductPages, productPage } from '../src/pages.js';

// A clock the test moves by hand.
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// renderProduct, counting how often it runs.
function countingRender() {
  const render = (args) => {
    render.calls++;
    return renderProduct(args);
  };
  render.calls = 0;
  return render;
}

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

test('pages are kept for 60 seconds', () => {
  assert.equal(PAGE_TTL_MS, 60_000);
});

test('a repeat request within 60 seconds is served from the cache', () => {
  const now = fakeClock();
  const render = countingRender();
  const pages = createProductPages({ now, render });
  const first = pages.productPage('lamp');
  now.advance(30_000);
  assert.equal(pages.productPage('lamp'), first);
  now.advance(29_999);
  assert.equal(pages.productPage('lamp'), first);
  assert.equal(render.calls, 1);
});

test('a request 60 seconds after the page was rendered gets a fresh one', () => {
  const now = fakeClock();
  const render = countingRender();
  const pages = createProductPages({ now, render });
  pages.productPage('lamp');
  now.advance(60_000);
  assert.match(pages.productPage('lamp'), /<h1>Desk lamp<\/h1>/);
  assert.equal(render.calls, 2);
});

test('each product is cached on its own', () => {
  const render = countingRender();
  const pages = createProductPages({ now: fakeClock(), render });
  pages.productPage('lamp');
  pages.productPage('mug');
  pages.productPage('lamp');
  pages.productPage('mug');
  assert.equal(render.calls, 2);
  assert.match(pages.productPage('mug'), /Coffee mug/);
});

test('an unknown product is not cached and renders nothing', () => {
  const render = countingRender();
  const pages = createProductPages({ now: fakeClock(), render });
  assert.equal(pages.productPage('spaceship'), null);
  assert.equal(render.calls, 0);
});

test('clear forgets every cached page', () => {
  const render = countingRender();
  const pages = createProductPages({ now: fakeClock(), render });
  pages.productPage('lamp');
  pages.clear();
  pages.productPage('lamp');
  assert.equal(render.calls, 2);
});

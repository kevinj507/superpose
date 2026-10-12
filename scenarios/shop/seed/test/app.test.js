import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handle } from '../src/app.js';

test('GET / answers with the home page', async () => {
  const res = await handle({ method: 'GET', path: '/' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /<title>Tiny Shop<\/title>/);
});

test('GET /products/<id> answers with that product\'s page', async () => {
  const res = await handle({ method: 'GET', path: '/products/lamp' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /<h1>Desk lamp<\/h1>/);
  assert.match(res.body, /<span class="price">\$\d+\.\d\d<\/span>/);
});

test('POST /products/<id>/buy buys one and says what it cost', async () => {
  const res = await handle({ method: 'POST', path: '/products/mug/buy' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.product, 'mug');
  assert.equal(typeof body.price, 'number');
  assert.ok(body.price > 0);
});

test('a query string does not change the route', async () => {
  const res = await handle({ method: 'GET', path: '/products/lamp?ref=home' });
  assert.equal(res.status, 200);
});

test('unknown products, unknown paths and wrong methods are 404s', async () => {
  assert.equal((await handle({ method: 'GET', path: '/products/spaceship' })).status, 404);
  const refused = await handle({ method: 'POST', path: '/products/spaceship/buy' });
  assert.equal(refused.status, 404);
  assert.equal(JSON.parse(refused.body).ok, false);
  assert.equal((await handle({ method: 'GET', path: '/nowhere' })).status, 404);
  assert.equal((await handle({ method: 'GET', path: '/products/lamp/buy' })).status, 404);
  assert.equal((await handle({ method: 'DELETE', path: '/products/lamp' })).status, 404);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server.js';

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

// One real HTTP request to the test server.
function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('createServer is a node:http server', () => {
  assert.ok(server instanceof http.Server);
});

test('it serves the home page', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.body, /<title>Tiny Shop<\/title>/);
});

test('it serves a product page', async () => {
  const res = await request('GET', '/products/lamp');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>Desk lamp<\/h1>/);
});

test('it takes a purchase and answers JSON', async () => {
  const res = await request('POST', '/products/mug/buy');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.product, 'mug');
  assert.equal(typeof body.price, 'number');
});

test('it passes 404s through', async () => {
  assert.equal((await request('GET', '/products/spaceship')).status, 404);
  assert.equal((await request('GET', '/nowhere')).status, 404);
});

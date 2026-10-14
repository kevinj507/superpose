#!/usr/bin/env node
// Independent acceptance checks. The public task defines every interface
// exercised here; agents do not receive this evaluator or reference fixes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const HERE = fileURLToPath(import.meta.url);
export const CONTRACT_CASES = ['pay-shown', 'demand-pricing', 'cache-reuse', 'order-record', 'catalog-home', 'http-server'];
async function load(repo, module) { return import(pathToFileURL(resolve(repo, 'src', `${module}.js`)).href); }
async function fresh(repo) {
  const [pricing, orders, pages] = await Promise.all(['pricing', 'orders', 'pages'].map((m) => load(repo, m)));
  if (pricing.resetPrices) await pricing.resetPrices();
  if (orders.resetOrders) await orders.resetOrders();
  if (pages.clearProductPages) await pages.clearProductPages();
  return { pricing, orders, pages };
}
const money = (page) => {
  const match = String(page).match(/<span class="price">\$(\d+\.\d{2})<\/span>/);
  assert.ok(match, 'a product page must expose its displayed price');
  return Number(match[1]);
};
export async function checkCase(repo, name) {
  const { pricing, orders, pages } = await fresh(repo);
  const { handle } = await load(repo, 'app');
  const { products } = await load(repo, 'catalog');
  if (name === 'pay-shown') {
    for (const id of ['lamp', 'mug', 'lamp', 'lamp', 'mug']) {
      const page = await handle({ method: 'GET', path: `/products/${id}` });
      assert.equal(page.status, 200);
      const paid = await handle({ method: 'POST', path: `/products/${id}/buy` });
      assert.equal(paid.status, 200);
      const body = JSON.parse(paid.body);
      assert.equal(body.ok, true);
      assert.equal(body.price, money(page.body), `${id}: charged a different price from its page`);
    }
  } else if (name === 'demand-pricing') {
    assert.equal(typeof pricing.recordPurchase, 'function');
    assert.equal(typeof pricing.resetPrices, 'function');
    assert.equal(pricing.priceOf('lamp'), 40);
    for (const expected of [40, 42, 44.10, 46.31]) assert.equal((await orders.buy('lamp')).price, expected);
    assert.equal(pricing.priceOf('lamp'), 48.63);
    assert.equal(pricing.priceOf('mug'), 12.50);
    assert.equal(pricing.recordPurchase('mug'), 13.13);
    await pricing.resetPrices();
    assert.equal(pricing.priceOf('lamp'), 40);
  } else if (name === 'cache-reuse') {
    assert.equal(typeof pages.createProductPages, 'function');
    assert.equal(pages.PAGE_TTL_MS, 60_000);
    const { renderProduct } = await load(repo, 'render');
    let now = 1000, renders = 0;
    const cached = pages.createProductPages({ now: () => now, render: (args) => { renders++; return renderProduct(args); } });
    assert.equal(money(await cached.productPage('lamp')), 40);
    now += 30_000;
    await cached.productPage('lamp');
    assert.equal(renders, 1, 'unchanged pages must actually reuse the cache');
    assert.equal(money(await cached.productPage('mug')), 12.50);
    await cached.productPage('mug');
    assert.equal(renders, 2, 'products must have distinct cache entries');
    await pricing.recordPurchase('lamp');
    assert.equal(money(await cached.productPage('lamp')), 42, 'refresh after a price change');
    assert.equal(renders, 3);
    await cached.productPage('mug');
    assert.equal(renders, 3, 'another product’s purchase must not invalidate an unchanged page');
    await cached.productPage('lamp');
    assert.equal(renders, 3);
    now += 60_000;
    await cached.productPage('lamp');
    assert.equal(renders, 4, 'refresh at the expiry boundary');
    const previous = renders;
    assert.equal(await cached.productPage('missing-product'), null);
    assert.equal(renders, previous, 'unknown products must not render');
    await cached.clear();
    await cached.productPage('lamp');
    assert.equal(renders, previous + 1, 'clear must forget cached pages');
  } else if (name === 'order-record') {
    const paid = await orders.buy('lamp');
    assert.deepEqual(paid, { ok: true, product: 'lamp', price: 40 });
    const paidNext = await orders.buy('lamp');
    assert.equal(paidNext.price, 42);
    assert.deepEqual(orders.orderHistory(), [{ product: 'lamp', price: 40 }, { product: 'lamp', price: 42 }]);
    const missing = await handle({ method: 'POST', path: '/products/missing-product/buy' });
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).ok, false);
    assert.equal(orders.orderHistory().length, 2);
    assert.equal((await handle({ method: 'GET', path: '/products/missing-product' })).status, 404);
  } else if (name === 'catalog-home') {
    const catalog = products;
    assert.deepEqual(catalog, [
      { id: 'lamp', name: 'Desk lamp', basePrice: 40 },
      { id: 'mug', name: 'Coffee mug', basePrice: 12.5 },
      { id: 'blanket', name: 'Wool blanket', basePrice: 65 },
    ], 'the read-only catalog stays intact');
    await orders.buy('lamp');
    const home = await handle({ method: 'GET', path: '/' });
    assert.equal(home.status, 200);
    let previous = -1;
    for (const p of catalog) {
      const at = home.body.indexOf(`/products/${p.id}`);
      assert.ok(at > previous, 'the home page must link catalog products in catalog order');
      previous = at;
      assert.ok(home.body.includes(p.name));
      const page = await handle({ method: 'GET', path: `/products/${p.id}` });
      assert.equal(page.status, 200);
      assert.ok(page.body.includes(p.name));
      assert.equal(money(page.body), pricing.priceOf(p.id));
    }
    assert.ok(home.body.includes('$42.00'), 'the home page must show the current lamp price');
  } else if (name === 'http-server') {
    const { createServer } = await load(repo, 'server');
    assert.equal(typeof createServer, 'function');
    const server = createServer();
    assert.equal(server.listening, false, 'creating a server must not start listening');
    try {
      await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const page = await fetch(`${base}/products/lamp`);
      assert.equal(page.status, 200);
      assert.equal(money(await page.text()), 40);
      const paid = await fetch(`${base}/products/lamp/buy`, { method: 'POST' });
      assert.deepEqual(await paid.json(), { ok: true, product: 'lamp', price: 40 });
      assert.equal((await fetch(`${base}/products/missing-product`)).status, 404);
    } finally { await new Promise((done) => server.close(done)); }
  } else throw new Error(`unknown contract case ${name}`);
}

export function evaluateContract(repo, { timeoutMs = 30_000, cases = CONTRACT_CASES } = {}) {
  const checks = cases.map((name) => {
    const child = spawnSync(process.execPath, [HERE, '--case', name, '--repo', resolve(repo)], {
      encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' }, maxBuffer: 100_000,
    });
    let result;
    try { result = JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch {}
    if (child.error || !result || result.case !== name) return { case: name, outcome: 'error', detail: child.error?.code ?? 'no valid evaluator result' };
    if (result.outcome === 'pass' && child.status !== 0) return { case: name, outcome: 'error', detail: 'inconsistent evaluator exit' };
    return result;
  });
  return { pass: checks.every((c) => c.outcome === 'pass'), checks };
}
if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  const repo = process.argv[process.argv.indexOf('--repo') + 1];
  const name = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
  if (name) {
    try { await checkCase(repo, name); console.log(JSON.stringify({ case: name, outcome: 'pass' })); }
    catch (error) { console.log(JSON.stringify({ case: name, outcome: error.code === 'ERR_ASSERTION' ? 'fail' : 'error', detail: error.message })); process.exitCode = 1; }
  } else { const result = evaluateContract(repo); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1; }
}

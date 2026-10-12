// The shop's front door. handle({ method, path }) answers one request with
// a promise of { status, headers, body }. It does no I/O of its own: tests
// call it directly, and a server only has to pass requests in and write the
// answers out.
//
//   GET  /                    the home page (HTML)
//   GET  /products/<id>       the product's page (HTML)
//   POST /products/<id>/buy   buys one; JSON { ok, product, price }, where
//                             price is what the buyer paid
//
// Anything else is a 404.
import { homePage } from './home.js';
import { buy } from './orders.js';
import { productPage } from './pages.js';

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

export async function handle({ method = 'GET', path = '/' } = {}) {
  const verb = String(method).toUpperCase();
  const route = String(path).split('?')[0];

  if (route === '/' && verb === 'GET') return answer(200, HTML, await homePage());

  const page = route.match(/^\/products\/([^/]+)$/);
  if (page && verb === 'GET') {
    const html = await productPage(decode(page[1]));
    return html == null ? notFound() : answer(200, HTML, html);
  }

  const purchase = route.match(/^\/products\/([^/]+)\/buy$/);
  if (purchase && verb === 'POST') {
    const result = await buy(decode(purchase[1]));
    return answer(result.ok ? 200 : 404, JSON_TYPE, JSON.stringify(result));
  }

  return notFound();
}

function answer(status, type, body) {
  return { status, headers: { 'content-type': type }, body };
}

function notFound() {
  return answer(404, TEXT, 'Not found\n');
}

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

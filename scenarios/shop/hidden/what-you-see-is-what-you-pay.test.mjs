// The shop scenario's hidden test. Agents never see it.
//
// What you see is what you pay: load the desk lamp's page, buy one, load the
// page again, buy again, three rounds in all. Every purchase must charge the
// price the page showed just before it, give or take half a cent (a page
// shows cents; a price may carry more digits).
//
// It drives the shop only through handle() in src/app.js, the interface no
// task changes, and reads the price from the page's <span class="price">
// (written by src/render.js, which no task changes either). check.mjs copies
// a checkout to a temporary folder and puts this file in a folder of its own
// at the top, so ../src/app.js is that copy's app; dropped into a checkout's
// test/ folder it runs with node --test just the same.
//
// A failed assertion is a real failure: the shop charged something other
// than what it showed. Anything that keeps the scenario from running (no
// handle(), a page that is missing or shows no price, a purchase that is
// refused or throws) is a CannotRun error, which check.mjs reports as
// "error", not "fail".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

const PRODUCT = 'lamp'; // the $40.00 desk lamp in src/catalog.js
const ROUNDS = 3;
const HALF_CENT = 0.005 + 1e-9;
const TIMEOUT_MS = 30_000; // a shop that never answers is an error, not a hang

class CannotRun extends Error {
  name = 'CannotRun';
}

test('what you see is what you pay', { timeout: TIMEOUT_MS }, async (t) => {
  const handle = await loadHandle();
  const trail = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const shown = await shownPrice(handle, PRODUCT);
    const paid = await buy(handle, PRODUCT);
    trail.push({ shown, paid });
    await pause(5); // let any bookkeeping that follows a purchase settle
  }
  const story = `${PRODUCT}: ${trail.map(({ shown, paid }) => `shown ${money(shown)}, paid ${money(paid)}`).join('; ')}`;
  t.diagnostic(`trail: ${story}`);
  trail.forEach(({ shown, paid }, i) => {
    assert.ok(
      Math.abs(paid - shown) <= HALF_CENT,
      `purchase ${i + 1} of ${PRODUCT} charged ${money(paid)}, but its page showed ${money(shown)} just before it (${story})`,
    );
  });
});

async function loadHandle() {
  let app;
  try {
    app = await import('../src/app.js');
  } catch (err) {
    throw new CannotRun(`src/app.js could not be loaded: ${firstLine(err)}`);
  }
  const handle = [app.handle, app.default?.handle].find((f) => typeof f === 'function');
  if (!handle) throw new CannotRun('src/app.js does not export a handle() function');
  return handle;
}

async function request(handle, method, path) {
  let res;
  try {
    res = await handle({ method, path, url: path, headers: {} });
  } catch (err) {
    throw new CannotRun(`handle() threw on ${method} ${path}: ${firstLine(err)}`);
  }
  if (!res || typeof res !== 'object') {
    throw new CannotRun(`handle() answered ${method} ${path} with ${res === null ? 'null' : typeof res}, not { status, headers, body }`);
  }
  const body = await res.body;
  const text = typeof body === 'string' ? body
    : body instanceof Uint8Array ? Buffer.from(body).toString('utf8')
    : body == null ? ''
    : typeof body === 'object' ? JSON.stringify(body)
    : String(body);
  return { status: Number(res.status ?? res.statusCode), body, text };
}

const succeeded = (res) => res.status >= 200 && res.status < 300;

async function shownPrice(handle, id) {
  const path = `/products/${id}`;
  const res = await request(handle, 'GET', path);
  if (!succeeded(res)) throw new CannotRun(`GET ${path} answered ${res.status}: ${snippet(res.text)}`);
  const price = readPrice(res.text);
  if (price === null) throw new CannotRun(`the page at ${path} shows no price that can be read: ${snippet(res.text)}`);
  return price;
}

// The price on a page: the first element whose class list includes "price"
// and holds an amount, or failing that the first dollar amount on the page.
function readPrice(html) {
  for (const tag of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const cls = tag[2].match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const classes = (cls?.[1] ?? cls?.[2] ?? cls?.[3] ?? '').split(/\s+/);
    if (!classes.includes('price')) continue;
    const after = html.slice(tag.index + tag[0].length, tag.index + tag[0].length + 200);
    const end = after.indexOf(`</${tag[1]}`);
    const amount = parseAmount((end >= 0 ? after.slice(0, end) : after).replace(/<[^>]*>/g, ' '));
    if (amount !== null) return amount;
  }
  const loose = html.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  return loose ? parseAmount(loose[1]) : null;
}

async function buy(handle, id) {
  const path = `/products/${id}/buy`;
  const res = await request(handle, 'POST', path);
  if (!succeeded(res)) throw new CannotRun(`POST ${path} answered ${res.status}: ${snippet(res.text)}`);
  let data = res.body;
  if (!data || typeof data !== 'object' || data instanceof Uint8Array) {
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new CannotRun(`POST ${path} did not answer JSON: ${snippet(res.text)}`);
    }
  }
  if (!data || typeof data !== 'object' || data.ok === false) throw new CannotRun(`POST ${path} did not complete the purchase: ${snippet(res.text)}`);
  const paid = [data.price, data.pricePaid, data.paid, data.order?.price].map(asAmount).find((n) => n !== null);
  if (paid === undefined) throw new CannotRun(`POST ${path} did not say what the buyer paid: ${snippet(res.text)}`);
  return paid;
}

function asAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' ? parseAmount(value) : null;
}

function parseAmount(text) {
  const m = String(text).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function money(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? `$${n.toFixed(2)}` : `$${n}`;
}

function snippet(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat || '(empty)';
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}

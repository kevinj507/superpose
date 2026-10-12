// Product pages: productPage(id) is the HTML page for one product (from the
// catalog, its price and render.js), or null if the shop does not sell it.
// Pages load fast: each product's rendered page is kept for 60 seconds, and
// repeat requests for it within that time are served from the cache.
//
// Prices move with every purchase, so the price is read on every request
// (it is cheap; rendering is what the cache saves) and a cached page is only
// served while the product still costs what that page shows. A page never
// shows a price the buyer would not pay.
import { createCache } from './cache.js';
import { findProduct } from './catalog.js';
import { priceOf } from './pricing.js';
import { renderProduct } from './render.js';

export const PAGE_TTL_MS = 60_000;

// createProductPages({ ttlMs, now, render, price }): a productPage function
// with a cache of its own. The shop uses the one below; tests make their own
// with a clock they move by hand, a render function they can count and, if
// they like, a price function of their own.
export function createProductPages({ ttlMs = PAGE_TTL_MS, now = Date.now, render = renderProduct, price = priceOf } = {}) {
  const cache = createCache({ ttlMs, now }); // product id -> { price, html }
  function productPage(id) {
    const product = findProduct(id);
    if (!product) return null;
    const current = price(product.id);
    const cached = cache.get(product.id);
    if (cached && cached.price === current) return cached.html;
    return cache.set(product.id, { price: current, html: render({ product, price: current }) }).html;
  }
  return { productPage, clear: () => cache.clear() };
}

const pages = createProductPages();

export const productPage = pages.productPage;

// clearProductPages(): forget every cached page.
export const clearProductPages = pages.clear;

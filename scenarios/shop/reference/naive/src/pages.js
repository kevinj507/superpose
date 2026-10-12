// Product pages: productPage(id) is the HTML page for one product (from the
// catalog, its price and render.js), or null if the shop does not sell it.
// Pages load fast: each product's rendered page is kept for 60 seconds, and
// repeat requests for it within that time are served from the cache.
import { createCache } from './cache.js';
import { findProduct } from './catalog.js';
import { priceOf } from './pricing.js';
import { renderProduct } from './render.js';

export const PAGE_TTL_MS = 60_000;

// createProductPages({ ttlMs, now, render }): a productPage function with a
// cache of its own. The shop uses the one below; tests make their own with a
// clock they move by hand and a render function they can count.
export function createProductPages({ ttlMs = PAGE_TTL_MS, now = Date.now, render = renderProduct } = {}) {
  const cache = createCache({ ttlMs, now });
  function productPage(id) {
    const product = findProduct(id);
    if (!product) return null;
    return cache.getOrSet(product.id, () => render({ product, price: priceOf(product.id) }));
  }
  return { productPage, clear: () => cache.clear() };
}

const pages = createProductPages();

export const productPage = pages.productPage;

// clearProductPages(): forget every cached page.
export const clearProductPages = pages.clear;

// The home page: homePage() lists every product in the catalog, in catalog
// order, with its name linking to its page and its current price.
import { products } from './catalog.js';
import { priceOf } from './pricing.js';
import { escapeHtml, formatPrice, layout } from './render.js';

export function homePage() {
  const items = products.map(
    (p) =>
      `<li><a href="/products/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a> ` +
      `<span class="price">${formatPrice(priceOf(p.id))}</span></li>`,
  );
  return layout('Tiny Shop', `<h1>Tiny Shop</h1>\n<ul class="products">\n${items.join('\n')}\n</ul>`);
}

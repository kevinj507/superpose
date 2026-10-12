// Product pages: productPage(id) is the HTML page for one product (from the
// catalog, its price and render.js), or null if the shop does not sell it.
import { findProduct } from './catalog.js';
import { priceOf } from './pricing.js';
import { renderProduct } from './render.js';

export function productPage(id) {
  const product = findProduct(id);
  if (!product) return null;
  return renderProduct({ product, price: priceOf(product.id) });
}

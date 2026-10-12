// Pricing: priceOf(id) is what a product costs right now, in dollars.
// Today every product simply costs its base price from the catalog.
import { findProduct } from './catalog.js';

export function priceOf(id) {
  const product = findProduct(id);
  if (!product) throw new Error(`no such product: ${id}`);
  return product.basePrice;
}

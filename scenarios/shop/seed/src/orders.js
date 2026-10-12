// Orders: buy(id) buys one of a product and remembers the order.
import { findProduct } from './catalog.js';
import { priceOf } from './pricing.js';

const orders = [];

// buy(id): { ok: true, product, price }, where price is what the buyer paid,
// or { ok: false, error } for a product the shop does not sell.
export function buy(id) {
  const product = findProduct(id);
  if (!product) return { ok: false, error: `no such product: ${id}` };
  const price = priceOf(product.id);
  orders.push({ product: product.id, price });
  return { ok: true, product: product.id, price };
}

// orderHistory(): every order so far, oldest first, as { product, price }.
export function orderHistory() {
  return orders.map((order) => ({ ...order }));
}

// resetOrders(): forget every order (for tests).
export function resetOrders() {
  orders.length = 0;
}

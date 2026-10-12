// Pricing: priceOf(id) is what a product costs right now, in dollars. Prices
// follow demand: every purchase of a product raises that product's price by
// 5%, compounding and rounded to the cent. Other products keep their prices.
import { findProduct } from './catalog.js';

export const RISE_PER_PURCHASE = 0.05;

const cents = new Map(); // product id -> its price in cents, once it has moved

function product(id) {
  const found = findProduct(id);
  if (!found) throw new Error(`no such product: ${id}`);
  return found;
}

function centsOf(id) {
  return cents.get(id) ?? Math.round(product(id).basePrice * 100);
}

export function priceOf(id) {
  return centsOf(id) / 100;
}

// recordPurchase(id): one more of this product was sold, so its price rises
// by 5% for the next buyer. Returns the new price.
export function recordPurchase(id) {
  const next = Math.round(centsOf(id) * (1 + RISE_PER_PURCHASE));
  cents.set(product(id).id, next);
  return next / 100;
}

// resetPrices(): every product back at its base price (for tests).
export function resetPrices() {
  cents.clear();
}

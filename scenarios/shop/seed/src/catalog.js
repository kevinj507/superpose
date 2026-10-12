// The catalog: every product the shop sells, with its base price in dollars.
// It is read-only; nothing changes it while the shop runs.
const PRODUCTS = [
  { id: 'lamp', name: 'Desk lamp', basePrice: 40 },
  { id: 'mug', name: 'Coffee mug', basePrice: 12.5 },
  { id: 'blanket', name: 'Wool blanket', basePrice: 65 },
];

export const products = Object.freeze(PRODUCTS.map((product) => Object.freeze({ ...product })));

// findProduct(id): the product with that id, or null if the shop does not sell it.
export function findProduct(id) {
  return products.find((product) => product.id === id) ?? null;
}

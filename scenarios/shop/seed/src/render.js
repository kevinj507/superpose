// HTML for the shop's pages. Every page goes through layout(), and a price is
// always shown by formatPrice() inside <span class="price">, e.g.
// <span class="price">$40.00</span>.

export function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (c) => entities[c]);
}

// formatPrice(40) is "$40.00"; formatPrice(12.5) is "$12.50".
export function formatPrice(amount) {
  return `$${amount.toFixed(2)}`;
}

// layout(title, content): a whole HTML page around some content.
export function layout(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
<header><a href="/">Tiny Shop</a></header>
<main>
${content}
</main>
</body>
</html>
`;
}

// renderProduct({ product, price }): the page for one product, showing price.
export function renderProduct({ product, price }) {
  const id = escapeHtml(product.id);
  return layout(
    `${product.name} | Tiny Shop`,
    `<article class="product" data-id="${id}">
<h1>${escapeHtml(product.name)}</h1>
<p>Price: <span class="price">${formatPrice(price)}</span></p>
<form method="post" action="/products/${id}/buy"><button type="submit">Buy</button></form>
</article>`,
  );
}

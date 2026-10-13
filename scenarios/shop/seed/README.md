# Tiny Shop

A tiny web shop in plain Node 22: ES modules, no dependencies. It sells a few products, shows a page for each one, and takes orders. Everything is kept in memory, so the shop starts empty every time it starts.

## How it fits together

- `src/catalog.js`: the products the shop sells, each with an `id`, a `name` and a `basePrice` in dollars (the desk lamp, `lamp`, is $40.00). `findProduct(id)` looks one up. The catalog is read-only.
- `src/pricing.js`: `priceOf(id)`, what a product costs right now. Today that is its base price.
- `src/orders.js`: `buy(id)` buys one of a product, records the order and returns `{ ok, product, price }`, where `price` is what the buyer paid. `orderHistory()` lists the orders; `resetOrders()` clears them for tests.
- `src/render.js`: the HTML. `layout(title, content)` makes a whole page, `formatPrice(amount)` writes `$40.00`, `escapeHtml(text)` makes text safe, and `renderProduct({ product, price })` is a product's page. A price always appears as `<span class="price">$40.00</span>`.
- `src/pages.js`: `productPage(id)`, a product's page (catalog, price and render together), or `null` for a product the shop does not sell.
- `src/home.js`: `homePage()`, the front page.
- `src/app.js`: `handle({ method, path })`, which answers one request with a promise of `{ status, headers, body }`:
  - `GET /`: the home page
  - `GET /products/<id>`: the product's page
  - `POST /products/<id>/buy`: buys one and answers JSON `{ ok, product, price }`

  Anything else is a 404. `handle` does no I/O, so tests call it directly: `await handle({ method: 'GET', path: '/products/lamp' })`.

## The constitution

`constitution/` holds what the shop keeps whatever is built, each article a test: what you see is what you pay (a buyer is charged the price the page showed just before the purchase), an unknown product has no page and cannot be bought, every product page shows the name and a price like `$40.00`, and every purchase says what was paid. These files belong to the owner and no task changes them.

## Tests

`npm test` runs every test in `test/` and `constitution/` with `node --test`. Each `src/<name>.js` has its tests in `test/<name>.test.js`, written with `node:test` and `node:assert/strict`.

The shop's state (orders, and anything else a module keeps) lives in module variables. `node --test` runs each test file in a process of its own, so one test file never sees another's purchases; within a file, reset what you change (for example with `resetOrders()` in a `beforeEach`).

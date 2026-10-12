# tiny-text

Small text helpers for Node 22, one function per file, no dependencies.

- `src/<name>.js` exports one function, named in camelCase after the file.
- `test/<name>.test.js` tests it with `node:test` and `node:assert/strict`.
- `npm test` runs every test.

`src/capitalize.js` and its test show the house style.

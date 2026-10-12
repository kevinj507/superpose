# The world, and how modules share it

A world is a square grid of `SIZE` x `SIZE` cells (`SIZE = 96`). `generate(seed)` in `src/world.js` creates an empty world and runs every module in `src/modules.js`, in order. Each module lives in its own file, `src/gen/<name>.js`, and exports:

```js
export const name = 'terrain';
export function run(world, rng) { /* write your layer(s) into world.layers */ }
```

`rng()` returns a float in [0, 1), like `Math.random()`, but seeded: never call `Math.random()`.

Modules talk to each other only through `world.layers`. Read the layers of modules that run before you; write only your own.

| Layer | Written by | Shape |
|---|---|---|
| `height` | terrain | `Float32Array(SIZE*SIZE)`, 0 (deep sea) to 1 (peaks), smooth (neighbouring cells differ by little) |
| `water` | water | `Uint8Array(SIZE*SIZE)`, 1 where the cell is sea (height below the sea level the module picks, about 0.35) |
| `river` | rivers | `Uint8Array(SIZE*SIZE)`, 1 on river cells; each river flows downhill from high ground to the sea |
| `biome` | biomes | `Uint8Array(SIZE*SIZE)`, one of `BIOMES` in `src/world.js` (sea, beach, grass, forest, hills, mountain, snow) |
| `forest` | forests | `Uint8Array(SIZE*SIZE)`, 1 where a tree stands (only on grass or forest biome, never on water or rivers) |
| `towns` | towns | `Array<{ x, y, size }>`, 3 to 8 towns on dry, flat land, near a river or the coast, at least 10 cells apart |
| `road` | roads | `Uint8Array(SIZE*SIZE)`, 1 on road cells; every town connected to the nearest other town, avoiding water |
| `names` | names | `Array<string>`, one name per town, same order as `towns`, pronounceable, unique |

The cell at `(x, y)` is index `y * SIZE + x`. Helpers in `src/world.js`: `idx(x, y)`, `inBounds(x, y)`, `neighbours(x, y)`.

Each module comes with its own tests in `test/<name>.test.js` (`node --test`). The tests run in a container on every push, and again on the merged result before your work lands.

// The world pipeline. Every module gets the world and a source of randomness,
// and writes its layers. See WORLD.md for the contract between modules.
import { createRng } from './rng.js';
import { MODULES } from './modules.js';

export const SIZE = 96;
export const BIOMES = ['sea', 'beach', 'grass', 'forest', 'hills', 'mountain', 'snow'];

export const idx = (x, y) => y * SIZE + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
export function neighbours(x, y) {
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (inBounds(x + dx, y + dy)) out.push([x + dx, y + dy]);
  return out;
}

// Randomness: one stream for the whole world, drawn from by every module in
// turn. (The decision this line represents; see plan.json.)
export function generate(seed, modules = MODULES) {
  const world = { seed: String(seed), size: SIZE, layers: {} };
  const rng = createRng(String(seed));
  for (const m of modules) m.run(world, rng);
  return world;
}

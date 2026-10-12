// Draws whatever layers exist, so the world fills in as modules land.
import { BIOMES, SIZE, idx } from './world.js';

const CELL = 6;
const ELEVATION = [
  [0.2, '#123a63'], [0.3, '#1d5a8c'], [0.35, '#2e78b0'], [0.38, '#d9c58b'],
  [0.55, '#7fae5a'], [0.7, '#5f8f45'], [0.82, '#8c8a72'], [0.92, '#a7a39a'], [1.01, '#eef0f2'],
];
const BIOME_COLOUR = {
  sea: '#2e78b0', beach: '#d9c58b', grass: '#86b35f', forest: '#4f7f3b', hills: '#9a9a6e', mountain: '#8f8c86', snow: '#eef0f2',
};

function shade(h) {
  for (const [limit, colour] of ELEVATION) if (h < limit) return colour;
  return '#ffffff';
}

export function render(world, canvas) {
  canvas.width = SIZE * CELL;
  canvas.height = SIZE * CELL;
  const g = canvas.getContext('2d');
  const L = world.layers;
  g.fillStyle = '#0d1b2a';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = idx(x, y);
      let colour = L.height ? shade(L.height[i]) : (x + y) % 2 ? '#16263a' : '#132235';
      if (L.biome) colour = BIOME_COLOUR[BIOMES[L.biome[i]]] ?? colour;
      if (L.water?.[i]) colour = L.height && L.height[i] < 0.25 ? '#1d5a8c' : '#2e78b0';
      g.fillStyle = colour;
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
      if (L.height && !L.water?.[i]) {
        // A little relief: lighter on slopes facing the top-left light.
        const up = L.height[idx(Math.max(0, x - 1), Math.max(0, y - 1))];
        const d = (L.height[i] - up) * 3;
        g.fillStyle = d > 0 ? `rgba(255,255,255,${Math.min(0.25, d)})` : `rgba(0,0,0,${Math.min(0.3, -d)})`;
        g.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }
  const cells = (layer, colour, inset = 0) => {
    if (!layer) return;
    g.fillStyle = colour;
    for (let i = 0; i < layer.length; i++) {
      if (layer[i]) g.fillRect((i % SIZE) * CELL + inset, Math.floor(i / SIZE) * CELL + inset, CELL - 2 * inset, CELL - 2 * inset);
    }
  };
  cells(L.river, '#4aa3df', 1);
  cells(L.road, '#b08d57', 2);
  if (L.forest) {
    g.fillStyle = '#2d5a27';
    for (let i = 0; i < L.forest.length; i++) {
      if (!L.forest[i]) continue;
      const px = (i % SIZE) * CELL;
      const py = Math.floor(i / SIZE) * CELL;
      g.beginPath();
      g.moveTo(px + CELL / 2, py);
      g.lineTo(px + CELL, py + CELL);
      g.lineTo(px, py + CELL);
      g.fill();
    }
  }
  (L.towns ?? []).forEach((t, n) => {
    const px = t.x * CELL;
    const py = t.y * CELL;
    g.fillStyle = '#f3e9d2';
    g.fillRect(px - 4, py - 3, 9, 7);
    g.fillStyle = '#b5523b';
    g.beginPath();
    g.moveTo(px - 5, py - 3);
    g.lineTo(px + 0.5, py - 8);
    g.lineTo(px + 6, py - 3);
    g.fill();
    const label = L.names?.[n];
    if (label) {
      g.font = '600 12px system-ui, sans-serif';
      g.fillStyle = 'rgba(13,27,42,0.75)';
      const w = g.measureText(label).width;
      g.fillRect(px + 8, py - 9, w + 8, 16);
      g.fillStyle = '#ffffff';
      g.fillText(label, px + 12, py + 3);
    }
  });
}

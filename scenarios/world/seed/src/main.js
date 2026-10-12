import { generate } from './world.js';
import { render } from './render.js';

const canvas = document.getElementById('world');
const input = document.getElementById('seed');
const seedFromHash = () => decodeURIComponent(location.hash.slice(1)) || 'superpose';

function draw() {
  const seed = seedFromHash();
  input.value = seed;
  const started = performance.now();
  const world = generate(seed);
  render(world, canvas);
  const built = Object.keys(world.layers);
  document.getElementById('status').textContent =
    `${built.length ? built.join(', ') : 'no layers yet'} · ${(performance.now() - started).toFixed(0)} ms`;
  document.getElementById('towns').innerHTML = (world.layers.towns ?? [])
    .map((t, i) => `<li>${world.layers.names?.[i] ?? `Town ${i + 1}`} <span>(${t.x}, ${t.y})</span></li>`)
    .join('');
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  location.hash = encodeURIComponent(input.value.trim() || 'superpose');
});
document.getElementById('random').addEventListener('click', () => {
  location.hash = Math.random().toString(36).slice(2, 8);
});
addEventListener('hashchange', draw);
draw();

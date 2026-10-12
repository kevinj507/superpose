import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, SIZE } from '../src/world.js';
import { MODULES } from '../src/modules.js';

test('the pipeline runs every module and the same seed gives the same world', () => {
  assert.equal(MODULES.length, 8);
  const a = generate('reproducible');
  const b = generate('reproducible');
  assert.equal(a.size, SIZE);
  assert.deepEqual(Object.keys(a.layers), Object.keys(b.layers));
  for (const key of Object.keys(a.layers)) assert.deepEqual(a.layers[key], b.layers[key], key);
});

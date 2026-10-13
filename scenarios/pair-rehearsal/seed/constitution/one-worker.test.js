// Constitution: at most one of the two notes says an agent worked on it.
// Each file alone keeps this; the two together, as scripted agents write
// them, break it. The gate must catch the pair.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const says = (file) => /worked on/.test(readFileSync(new URL(`../notes/${file}`, import.meta.url), 'utf8'));

test('at most one note says an agent worked on it', () => {
  const both = says('a.txt') && says('b.txt');
  assert.equal(both, false, 'both notes/a.txt and notes/b.txt say an agent worked on them');
});

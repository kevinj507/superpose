import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache } from '../src/cache.js';

// A clock the test moves by hand.
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('a value is there until ttlMs after it was set, then gone', () => {
  const now = fakeClock();
  const cache = createCache({ ttlMs: 1000, now });
  cache.set('a', 1);
  now.advance(999);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.has('a'), true);
  now.advance(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.has('a'), false);
});

test('setting a value again starts its time over', () => {
  const now = fakeClock();
  const cache = createCache({ ttlMs: 1000, now });
  cache.set('a', 1);
  now.advance(800);
  cache.set('a', 2);
  now.advance(800);
  assert.equal(cache.get('a'), 2);
});

test('getOrSet makes a value only when there is no fresh one', () => {
  const now = fakeClock();
  const cache = createCache({ ttlMs: 1000, now });
  let made = 0;
  const make = () => ++made;
  assert.equal(cache.getOrSet('k', make), 1);
  assert.equal(cache.getOrSet('k', make), 1);
  assert.equal(made, 1);
  now.advance(1000);
  assert.equal(cache.getOrSet('k', make), 2);
  assert.equal(made, 2);
});

test('keys are kept apart', () => {
  const cache = createCache({ ttlMs: 1000, now: fakeClock() });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), undefined);
});

test('a stored undefined or null still counts as stored', () => {
  const cache = createCache({ ttlMs: 1000, now: fakeClock() });
  let made = 0;
  cache.getOrSet('nothing', () => {
    made++;
    return null;
  });
  assert.equal(cache.getOrSet('nothing', () => made++), null);
  assert.equal(made, 1);
  cache.set('u', undefined);
  assert.equal(cache.has('u'), true);
});

test('delete and clear forget values', () => {
  const cache = createCache({ ttlMs: 1000, now: fakeClock() });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  cache.clear();
  assert.equal(cache.get('b'), undefined);
});

test('ttlMs must be a positive number', () => {
  assert.throws(() => createCache(), RangeError);
  assert.throws(() => createCache({ ttlMs: 0 }), RangeError);
  assert.throws(() => createCache({ ttlMs: -5 }), RangeError);
  assert.throws(() => createCache({ ttlMs: 'soon' }), RangeError);
});

test('the clock is Date.now unless the caller gives one', () => {
  const cache = createCache({ ttlMs: 60_000 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

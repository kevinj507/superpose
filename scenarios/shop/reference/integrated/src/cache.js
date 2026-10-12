// A small in-memory cache that forgets: createCache({ ttlMs, now }) keeps each
// value for ttlMs milliseconds after it is set. now() is the clock, Date.now
// by default; tests pass their own and move time forward instead of waiting.
export function createCache({ ttlMs, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('createCache needs ttlMs, a positive number of milliseconds');
  const entries = new Map(); // key -> { value, expiresAt }

  // The entry for key if it is still fresh; a stale one is dropped.
  function fresh(key) {
    const entry = entries.get(key);
    if (entry && now() < entry.expiresAt) return entry;
    entries.delete(key);
    return undefined;
  }

  function set(key, value) {
    entries.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    get: (key) => fresh(key)?.value,
    has: (key) => fresh(key) !== undefined,
    set,
    // The fresh value for key, or make()'s result, stored for next time.
    getOrSet(key, make) {
      const entry = fresh(key);
      return entry ? entry.value : set(key, make());
    },
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
  };
}

import { beforeAll, describe, expect, it } from 'vitest';
import { validateShopScenario } from '../scenarios/shop/reference/validate.mjs';

// The shop scenario (scenarios/shop): two groups of work, a page cache and
// dynamic pricing, that each pass their own tests and break each other once
// combined. This checks the scenario, not Superpose. Built from the seed and
// the reference work in temporary copies, the visible tests (npm test) pass,
// and the hidden check passes on the seed and on either group alone, fails on
// the naive combination, passes on the integrated one, and says "error", not
// "fail", when it cannot run. Plain JavaScript, like scripts.test.mjs: it runs
// npm test and hidden/check.mjs as child processes. The quick run skips npm
// test on the one-group copies; node scenarios/shop/reference/validate.mjs
// runs those too.

describe('the shop scenario', () => {
  let report;
  const variant = (name) => report.variants.find((v) => v.name === name);

  beforeAll(async () => {
    report = await validateShopScenario({ quick: true });
  }, 60_000);

  it('keeps the two groups of work in disjoint files, and the reference work inside its claims', () => {
    expect(report.scopes.problems).toEqual([]);
    expect(report.scopes.integratedDiffers).toEqual(['src/pages.js', 'test/pages.test.js']);
  });

  it.each(['seed', 'integrated'])('the visible tests pass: %s', (name) => {
    const { visible } = variant(name);
    expect(visible.ok, visible.tail).toBe(true);
    expect(visible.fail).toBe(0);
  });

  it('on the naive combination only the constitution fails among the visible tests', () => {
    // The constitution's "what you see is what you pay" is the hidden test
    // made visible: it passes with either group alone and fails on the pair.
    const { visible } = variant('naive');
    expect(visible.ok).toBe(false);
    expect(visible.fail).toBe(1);
    expect(visible.failing).toEqual(['what you see is what you pay']);
  });

  it('the hidden check passes on the seed, where prices never move', () => {
    expect(variant('seed').hidden).toMatchObject({ verdict: 'pass', code: 0 });
  });

  it('the hidden check passes with either group of work alone', () => {
    expect(variant('caching only').hidden).toMatchObject({ verdict: 'pass', code: 0 });
    const pricing = variant('pricing only').hidden;
    expect(pricing).toMatchObject({ verdict: 'pass', code: 0 });
    expect(pricing.detail).toContain('shown $42.00, paid $42.00');
  });

  it('the hidden check fails on the naive combination: the cached page shows the old price', () => {
    const { hidden } = variant('naive');
    expect(hidden).toMatchObject({ verdict: 'fail', code: 1 });
    expect(hidden.detail).toContain('purchase 2 of lamp charged $42.00, but its page showed $40.00 just before it');
  });

  it('the hidden check passes on the integrated combination, with prices that really move', () => {
    const { hidden } = variant('integrated');
    expect(hidden).toMatchObject({ verdict: 'pass', code: 0 });
    expect(hidden.detail).toContain('shown $42.00, paid $42.00; shown $44.10, paid $44.10');
  });

  it('the hidden check says error, not fail, when it cannot run', () => {
    expect(variant('no handle').hidden).toMatchObject({ verdict: 'error', code: 2, detail: expect.stringContaining('handle()') });
  });
});

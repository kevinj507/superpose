import { describe, expect, it } from 'vitest';
import { directorActions } from '../runner/director-policy.mjs';
const prose = { id: 'a1', kind: 'assumption', constitution: true };
const finding = { id: 'f1', kind: 'finding', status: 'unverified', effect: 'contradicts', targets: ['a1'], where: ['c1'], hedgeUntil: 0 };
describe('the scripted director uses authority and evidence', () => {
  it('does not use an expired hedge or a proposed article as evidence', () => {
    expect(directorActions([prose, finding])).toEqual([]);
    expect(directorActions([{ ...prose, constitution: false, check: 'false', proposal: { by: 'c1' } }, finding])).toEqual([]);
  });
  it('requests a mechanical check without claiming its result', () => {
    expect(directorActions([{ ...prose, check: 'bun test constitution/price.test.ts' }, finding])).toMatchObject([{ action: 'check', id: 'f1' }]);
    expect(directorActions([{ ...prose, check: 'false' }, { ...finding, evidence: { status: 'inconclusive' } }])).toEqual([]);
  });
  it('requires a reason and explicit destinations for publication', () => {
    expect(() => directorActions([finding], { findings: { f1: { action: 'verify' } } })).toThrow('Invalid owner policy');
    expect(() => directorActions([finding], { findings: { f1: { action: 'publish', reason: 'Alert the other group' } } })).toThrow('destination lines');
    expect(directorActions([finding], { findings: { f1: { action: 'publish', lines: ['b'], reason: 'Candidate result' } } })[0].action).toBe('publish');
  });
});

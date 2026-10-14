import { test, expect } from 'vitest';
import { budgetReached, tokenCostUpperBound } from '../runner/experiment-budget.mjs';
test('cached context does not prematurely exhaust the task budget',()=>{
  const observed={totalTokens:171892,inputTokens:170020,cachedInputTokens:152320,outputTokens:1872};
  expect(tokenCostUpperBound(observed)).toBeCloseTo(0.0221885);
  expect(budgetReached(observed)).toBe(false);
});
test('reserves request cost before the ceiling and keeps unavailable usage unknown',()=>{
  expect(budgetReached({inputTokens:2400000,outputTokens:100000})).toBe(true);
  expect(tokenCostUpperBound(null)).toBeNull();
});

import { test, expect } from 'vitest';
import { budgetReached, tokenCostUpperBound } from '../runner/experiment-budget.mjs';
import { RoleBudget } from '../runner/challenge-session.mjs';
test('cached context does not prematurely exhaust the task budget',()=>{
  const observed={totalTokens:171892,inputTokens:170020,cachedInputTokens:152320,outputTokens:1872};
  expect(tokenCostUpperBound(observed)).toBeCloseTo(0.0221885);
  expect(budgetReached(observed)).toBe(false);
});
test('reserves request cost before the ceiling and keeps unavailable usage unknown',()=>{
  expect(budgetReached({inputTokens:2400000,outputTokens:100000})).toBe(true);
  expect(tokenCostUpperBound(null)).toBeNull();
});
test('role limits persist across sessions and use one first-turn deadline',()=>{
  let now=100;
  const budget=new RoleBudget({now:()=>now});
  expect(budget.start()).toBeNull();
  for(let i=0;i<49;i++) expect(budget.addAction()).toBeNull();
  now=899_999;
  expect(budget.check()).toBeNull();
  expect(budget.addAction()).toBe('action');
  expect(budget.state).toMatchObject({actions:50,startedAt:100,deadlineAt:900_100,interrupt:'action'});
});
test('time ceiling starts on the first turn and stays shared',()=>{
  let now=10;
  const budget=new RoleBudget({now:()=>now});
  budget.start(); now=900_010;
  expect(budget.check()).toBe('time');
});

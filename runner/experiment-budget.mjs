// Conservative standard-tier API-equivalent cost, not subscription billing.
// All input is charged at cache-write rate, even when reads were cached.
export function tokenCostUpperBound(usage) {
  if (!Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) return null;
  return (usage.inputTokens * 0.125 + usage.outputTokens * 0.5) / 1e6;
}
export function budgetReached(usage, cap = 0.5) {
  const upper = tokenCostUpperBound(usage);
  // 64K configured context + the model's 128K maximum output, with room for
  // two requests while interrupt propagates: 2 * (0.008 + 0.064) < $0.16.
  return upper !== null && upper >= cap - 0.16;
}

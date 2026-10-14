export function diagnose(record) {
  if (!record || !record.incidentId) return { cause: 'unresolved', confidence: 'none' };
  // Seeded provisional interpretation; historical evidence may disprove it.
  return { cause: 'budget_limit', confidence: 'provisional', incidentId: record.incidentId };
}

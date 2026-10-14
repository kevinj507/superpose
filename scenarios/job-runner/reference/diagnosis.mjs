export function diagnose(record, evidence) {
  const b = evidence?.binding;
  if (!record?.incidentId || !evidence?.checked || !b || b.incidentId !== record.incidentId ||
      !['budget_limit', 'capacity_limit'].includes(evidence.cause) ||
      !['incidentId', 'workloadDigest', 'codeSha', 'configRevision', 'traceDigest', 'verifierVersion'].every(k => typeof b[k] === 'string' && b[k]) ||
      (record.binding && !['incidentId', 'workloadDigest', 'codeSha', 'configRevision', 'traceDigest', 'verifierVersion'].every(k => record.binding[k] === b[k]))) {
    return { cause: 'unresolved', confidence: 'none' };
  }
  return { cause: evidence.cause, confidence: 'verified', incidentId: record.incidentId, binding: { ...b } };
}

export function diagnose(record, evidence) {
  const report = evidence?.report;
  const b = report?.binding;
  if (!record?.incidentId || !record.binding || !report?.checked || !b || b.incidentId !== record.incidentId ||
      !['budget_limit', 'capacity_limit'].includes(report.cause) ||
      !['incidentId', 'workloadDigest', 'codeSha', 'configRevision', 'traceDigest', 'verifierVersion'].every(k => typeof b[k] === 'string' && b[k]) ||
      !['incidentId', 'workloadDigest', 'codeSha', 'configRevision', 'traceDigest', 'verifierVersion'].every(k => record.binding[k] === b[k])) {
    return { cause: 'unresolved', confidence: 'none' };
  }
  return { cause: report.cause, confidence: 'verified', incidentId: record.incidentId, binding: { ...b } };
}

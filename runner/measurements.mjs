// Graph events describe platform state, not what an agent read or repaired.
// Missing observations stay null; a replan or green own test is not a repair.
export function measureRun(snapshot, observations = []) {
  const events = snapshot.events ?? [];
  const first = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const delta = (from, to) => from !== null && to !== null && to >= from ? to - from : null;
  const findings = (snapshot.nodes ?? []).filter((n) => n.kind === 'finding').map((f) => {
    const platform = events.filter((e) => e.data?.finding === f.id);
    const filedAt = f.at ?? first(platform.filter((e) => e.type === 'finding.filed').map((e) => e.at));
    const verifiedAt = first(platform.filter((e) => e.type === 'finding.verified').map((e) => e.at));
    const receipts = observations.filter((o) => o.finding === f.id);
    const claims = [...new Set([...platform.filter((e) => ['claim.stale', 'claim.helped', 'finding.shared'].includes(e.type)).flatMap((e) => e.claims ?? []),
      ...receipts.map((o) => o.claim).filter(Boolean)])];
    return { finding: f.id, status: f.status, evidence: f.evidence?.status ?? null, filedAt, verifiedAt,
      verificationMs: delta(filedAt, verifiedAt), recipients: claims.map((claim) => {
        const observed = receipts.filter((o) => o.claim === claim);
        const time = (stage) => first(observed.filter((o) => o.stage === stage).map((o) => o.at));
        const deliveredAt = time('delivered'), presentedAt = time('presented'), actedAt = time('acted'), repairedAt = time('repaired');
        return { claim, deliveredAt, presentedAt, actedAt, repairedAt,
          verifiedToDeliveryMs: delta(verifiedAt, deliveredAt), deliveredToActionMs: delta(deliveredAt, actedAt),
          actionToRepairMs: delta(actedAt, repairedAt), filedToRepairMs: delta(filedAt, repairedAt) };
      }) };
  });
  const claims = (snapshot.nodes ?? []).filter((n) => n.kind === 'claim' && n.status !== 'superseded');
  return { findings, spend: { usd: claims.reduce((n, c) => n + (c.spend?.usd ?? 0), 0), turns: claims.reduce((n, c) => n + (c.spend?.turns ?? 0), 0) },
    missingObservations: findings.flatMap((f) => f.recipients.filter((r) => r.repairedAt === null).map((r) => ({ finding: f.finding, claim: r.claim }))) };
}

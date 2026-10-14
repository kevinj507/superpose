import { expect, it } from 'vitest';
import { measureRun } from '../runner/measurements.mjs';
it('separates platform verification from delivery, presentation, action and checked repair', () => {
  const snapshot = { nodes: [{ id: 'f1', kind: 'finding', status: 'verified', at: 100 }, { kind: 'claim', id: 'c1', status: 'claimed', spend: { usd: 0.1, turns: 4 } }],
    events: [{ type: 'finding.verified', at: 200, data: { finding: 'f1' } }, { type: 'claim.stale', at: 200, claims: ['c1'], data: { finding: 'f1' } },
      { type: 'claim.replanned', at: 220, claims: ['c1'], data: {} }] };
  const observations = [{ finding: 'f1', claim: 'c1', stage: 'delivered', at: 250 }, { finding: 'f1', claim: 'c1', stage: 'presented', at: 270 },
    { finding: 'f1', claim: 'c1', stage: 'acted', at: 400 }, { finding: 'f1', claim: 'c1', stage: 'repaired', at: 700 }];
  expect(measureRun(snapshot, observations).findings[0].recipients[0]).toMatchObject({ verifiedToDeliveryMs: 50, deliveredToActionMs: 150, actionToRepairMs: 300 });
  const unobserved = measureRun(snapshot).findings[0].recipients[0];
  expect(unobserved.deliveredAt).toBeNull();
  expect(unobserved.repairedAt).toBeNull();
  expect(measureRun(snapshot).missingObservations).toHaveLength(1);
});

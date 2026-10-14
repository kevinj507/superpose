import { OBSERVATION_SPEC } from './experiment-spec.mjs';
// The same limited owner service is available to all groups. Paraphrases
// are matched by the operator against the frozen promise, with that judgment
// recorded. A selected id alone does not establish semantic equivalence.
export function ownerResponse(request, { matchedIntent = false, approvedCheck = false, requestsUsed = 0 } = {}) {
  if (request.kind === 'blocked') return { action: 'observe', reason: 'Report the blocker to Kevin; provide no debugging hint.' };
  if (requestsUsed >= OBSERVATION_SPEC.owner.requestsPerTask) return { action: 'decline', reason: 'The pre-agreed request limit for this task is reached.' };
  const promise = OBSERVATION_SPEC.promises.find((p) => p.id === request.promise);
  if (!promise) return { action: 'decline', reason: 'The proposal is outside the published product promises for this run.' };
  if (request.kind === 'clarify') return { action: 'clarify', statement: promise.statement, reason: 'Repeat the published requirement without suggesting an implementation.' };
  if (request.kind !== 'propose') return { action: 'decline', reason: 'Use clarify, propose or blocked.' };
  if (!matchedIntent) return { action: 'decline', reason: 'The proposed rule does not match the published intent, or equivalence remains unconfirmed.' };
  if (request.checkFile && !approvedCheck) return { action: 'review-check', statement: promise.statement, reason: 'Run the proposed check against fixed passing, failing and shortcut examples before adoption.' };
  return { action: 'adopt', statement: promise.statement, executable: !!request.checkFile,
    reason: request.checkFile ? 'The rule matches the published intent and its check passed independent qualification.' : 'The rule matches the published intent; no executable check was supplied.' };
}

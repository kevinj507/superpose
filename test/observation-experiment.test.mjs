import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateContract } from '../scenarios/shop/hidden/experiment-contract.mjs';
import { armOrder, discoveryPlan, OBSERVATION_SPEC } from '../runner/experiment-spec.mjs';
import { observationAlerts } from '../runner/experiment-observer.mjs';
import { ownerResponse } from '../runner/experiment-owner-policy.mjs';
import { renderClaimMd } from '../runner/lib.mjs';
let root;
const repositories = {};
function variant(name, overlay = 'integrated') {
  const dir = join(root, name);
  cpSync('scenarios/shop/seed', dir, { recursive: true });
  cpSync(`scenarios/shop/reference/${overlay}`, dir, { recursive: true });
  return dir;
}
beforeAll(() => {
  root = mkdtempSync('/tmp/superpose-observation-test-');
  repositories.correct = variant('correct');
  repositories.broken = variant('broken', 'naive');
  repositories.noCache = variant('no-cache');
  const pageFile = join(repositories.noCache, 'src/pages.js');
  const text = readFileSync(pageFile, 'utf8').replace('const cache = createCache({ ttlMs, now });', 'const cache = { get: () => undefined, set: (_, value) => value, clear: () => {} };');
  writeFileSync(pageFile, text);
  repositories.frozenPrice = variant('frozen-price');
  writeFileSync(join(repositories.frozenPrice, 'src/pricing.js'), "import { findProduct } from './catalog.js';\nexport const priceOf = id => findProduct(id).basePrice;\nexport const recordPurchase = priceOf;\nexport const resetPrices = () => {};\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('the experiment tests the product, independently of agent tests', () => {
  it('accepts a working integration', () => { const r = evaluateContract(repositories.correct); expect(r.pass, JSON.stringify(r)).toBe(true); });
  it('detects the intended composition failure', () => {
    const r = evaluateContract(repositories.broken);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.case === 'pay-shown').outcome).toBe('fail');
    expect(r.checks.find((c) => c.case === 'demand-pricing').outcome).toBe('pass');
  });
  it('rejects solving the price check by disabling either requested feature', () => {
    expect(evaluateContract(repositories.noCache, { cases: ['cache-reuse'] }).checks[0].outcome).toBe('fail');
    expect(evaluateContract(repositories.frozenPrice, { cases: ['pay-shown'] }).pass).toBe(true);
    expect(evaluateContract(repositories.frozenPrice, { cases: ['demand-pricing'] }).checks[0].outcome).toBe('fail');
  });
  it('prepares a copy with clear promises and without the withheld check', () => {
    const out = join(root, 'prepared');
    const r = spawnSync(process.execPath, ['runner/prepare-observation.mjs', '--out', out, '--arm', 'matched-git'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
    expect(plan.constitution.some((a) => a.key === 'see-is-pay')).toBe(false);
    expect(readFileSync(join(out, 'seed/PROMISES.md'), 'utf8')).toContain('no intervening purchase');
    expect(readFileSync(join(out, 'seed/README.md'), 'utf8')).toContain('no solution or debugging hints');
    expect(readFileSync(join(out, 'seed/README.md'), 'utf8')).not.toContain('each article a test: what you see is what you pay');
    for (const file of ['hidden', 'reference', 'constitution/see-is-pay.test.js']) expect(existsSync(join(out, 'seed', file))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, 'operator-manifest.json'), 'utf8'));
    expect(manifest.runAuthorized).toBe(false);
    expect(manifest.model).toBe('gpt-6-luna');
    expect(manifest.agentPolicy).toMatchObject({ reasoningEffort: 'medium', session: 'fresh-per-task', inheritConversation: false, useMemory: false, generateMemory: false, allowModelFallback: false });
    expect(manifest.isolationVerified).toBe(false);
    expect(manifest.seedFiles.some((f) => f.path === 'PROMISES.md' && f.sha256.length === 64)).toBe(true);
    const brief = renderClaimMd({ claim: 'c1', statement: 'Cache pages', scope: ['src/pages.js'] }, null, join(out, 'seed'));
    for (const promise of OBSERVATION_SPEC.promises) expect(brief).toContain(promise.statement);
  });
  it('keeps every comparison reproducible, with compatible promises and fixed limits', () => {
    const original = JSON.parse(readFileSync('scenarios/shop/plan.json', 'utf8'));
    expect(discoveryPlan(original).claims.find((c) => c.key === 'fast-pages').statement).toContain('while its product and price are unchanged');
    expect(armOrder()).toEqual(armOrder());
    expect(new Set(armOrder()).size).toBe(3);
    expect(OBSERVATION_SPEC.limits.perTaskUsd * 18).toBe(OBSERVATION_SPEC.limits.pilotModelUsd);
  });
});
describe('observation is separate from intervention', () => {
  const now = 1_000_000;
  it('flags silence and repeated failures, but distinguishes expected waits', () => {
    const alerts = observationAlerts({ tasks: [
      { id: 'cache', status: 'working', lastProgressAt: now - 181_000 },
      { id: 'pricing', status: 'working', identicalFailuresSinceProgress: 3, lastProgressAt: now },
      { id: 'server', status: 'working', waitingFor: 'checks', checkDeadlineAt: now + 1000, lastProgressAt: now - 181_000 },
      { id: 'home', status: 'waiting', blocker: 'dependency' },
    ] }, now);
    expect(alerts.map((a) => [a.task, a.kind])).toEqual([['cache', 'possible-stall'], ['pricing', 'possible-stall'], ['server', 'waiting'], ['home', 'waiting']]);
  });
  it('reports explicit failure immediately and does not fabricate a successful result', () => {
    expect(observationAlerts({ tasks: [{ id: 'cache', status: 'working', blocker: 'authentication' }] }, now)[0]).toMatchObject({ kind: 'blocked', reason: 'authentication' });
    expect(observationAlerts({ tasks: [{ id: 'cache', status: 'done', lastProgressAt: 0 }] }, now)).toEqual([]);
  });
  it('supplies requirements, never a remedy, and qualifies proposed checks before adopting them', () => {
    const request = { kind: 'propose', promise: 'pay-shown', checkFile: 'test/quote.test.js' };
    expect(ownerResponse(request).action).toBe('decline');
    expect(ownerResponse(request, { matchedIntent: true }).action).toBe('review-check');
    expect(ownerResponse(request, { matchedIntent: true, approvedCheck: true })).toMatchObject({ action: 'adopt', executable: true });
    expect(ownerResponse({ kind: 'blocked' }).action).toBe('observe');
    expect(ownerResponse({ kind: 'clarify', promise: 'cache-reuse' }, { requestsUsed: 2 }).action).toBe('decline');
  });
});

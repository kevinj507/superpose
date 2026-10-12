import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { MemoryStore } from '../src/core/store';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, { leaseMs: 60_000, hedgeMs: 300_000, newToken: () => `tok${++n}` });
  const c = engine.addClaim({ statement: 'rate limiting', scope: ['src/rate/**'] });
  const { token } = engine.claim(c.id, 'agent');
  const push = (sha: string, paths: string[]) =>
    engine.recordPush(c.id, { sha, ref: 'refs/heads/main', before: null, paths, isHead: true });
  return { engine, clock, id: c.id, token, push };
}

describe('the verdict ledger: one verdict per exact commit', () => {
  it('passing checks make the commit verified; failing ones and broken runs say which', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    w.engine.recordCheck(w.id, 's1', { status: 'running', startedAt: 1 });
    expect(w.engine.verdictOf(w.id)).toMatchObject({ sha: 's1', verdict: 'unverified', checks: { status: 'running' } });
    expect(w.engine.recordCheck(w.id, 's1', { status: 'passed', exitCode: 0, startedAt: 1, finishedAt: 2 }).verdict).toBe('checks-passed');
    w.push('s2', ['src/rate/a.ts']);
    expect(w.engine.recordCheck(w.id, 's2', { status: 'failed', exitCode: 1, startedAt: 3, finishedAt: 4 }).verdict).toBe('checks-failed');
    w.push('s3', ['src/rate/a.ts']);
    expect(w.engine.recordCheck(w.id, 's3', { status: 'error', startedAt: 5, finishedAt: 6 }).verdict).toBe('verifier-failed');
  });

  it('a new commit starts unverified: the old verdict does not carry over', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    w.engine.recordCheck(w.id, 's1', { status: 'passed', exitCode: 0, startedAt: 1, finishedAt: 2 });
    w.push('s2', ['src/rate/a.ts', 'src/rate/b.ts']);
    expect(w.engine.verdictOf(w.id)).toMatchObject({ sha: 's2', verdict: 'unverified' });
    expect(w.engine.pushRecord(w.id, 's1')).toMatchObject({ verdict: 'checks-passed' });
  });

  it('passing tests do not excuse a scope violation', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts', 'package.json']);
    expect(w.engine.recordCheck(w.id, 's1', { status: 'passed', exitCode: 0, startedAt: 1, finishedAt: 2 }))
      .toMatchObject({ verdict: 'scope-violation', checks: { status: 'passed' } });
  });

  it('the agent hears the outcome of its checks at its next renewal', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    w.engine.recordCheck(w.id, 's1', { status: 'failed', exitCode: 1, startedAt: 1, finishedAt: 2 });
    expect(w.engine.renew(w.id, w.token).notices).toEqual([
      expect.objectContaining({ type: 'claim.checked', data: { sha: 's1', verdict: 'checks-failed', exitCode: 1 } }),
    ]);
  });
});

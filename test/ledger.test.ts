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

describe('assumptions declared by agents', () => {
  it('the same statement from two agents is one node, so one finding reaches both', () => {
    const clock = { t: 1_000_000, now() { return this.t; } };
    let n = 0;
    const engine = new Engine(new MemoryStore(), clock, { leaseMs: 60_000, hedgeMs: 300_000, newToken: () => `tok${++n}` });
    const [x, y, z] = ['x', 'y', 'z'].map((s) => engine.addClaim({ statement: s, scope: [`${s}/**`] }));
    const [tx, ty, tz] = [x!, y!, z!].map((c) => engine.claim(c.id, `agent-${c.id}`).token);
    const a1 = engine.declareAssumption(x!.id, tx!, { statement: 'KV reads are strongly consistent' });
    const a2 = engine.declareAssumption(y!.id, ty!, { statement: 'kv reads are strongly consistent.' });
    expect(a2.id).toBe(a1.id);
    const { finding } = engine.fileFinding(z!.id, tz!, { statement: 'KV is eventually consistent', effect: 'contradicts', targets: [a1.id] });
    expect(engine.verifyFinding(finding.id).affected.sort()).toEqual([x!.id, y!.id].sort());
    expect(() => engine.declareAssumption(z!.id, tz!, { assumption: a1.id })).toThrow(/contradicted/);
  });
});

describe('the ready set', () => {
  it('offers a claim whose agent died, so another agent picks it up', () => {
    const w = setup();
    expect(w.engine.ready().map((c) => c.id)).not.toContain(w.id);
    w.clock.t += 60_001;
    expect(w.engine.ready().map((c) => c.id)).toContain(w.id);
    expect(w.engine.claim(w.id, 'second agent').status).toBe('claimed');
  });
});

describe('scope matching', () => {
  it('handles the usual patterns, and pathological ones in no time', async () => {
    const { inScope } = await import('../src/core/scope');
    expect(inScope('src/a/b/c.ts', ['src/**'])).toBe(true);
    expect(inScope('src/a.ts', ['src/**/a.ts'])).toBe(true);
    expect(inScope('src/x/y/a.ts', ['src/**/a.ts'])).toBe(true);
    expect(inScope('src/x/a.ts', ['src/*.ts'])).toBe(false);
    expect(inScope('src/mul.test.js', ['src/mul*'])).toBe(true);
    expect(inScope('README.md', ['**'])).toBe(true);
    const started = Date.now();
    const evil = Array.from({ length: 40 }, () => '**').join('/') + '/x';
    const longPath = Array.from({ length: 200 }, (_, i) => `d${i}`).join('/') + '/y';
    expect(inScope(longPath, [evil, '*a*a*a*a*a*a*a*a*a*a*a*a*b'])).toBe(false);
    expect(inScope('a'.repeat(5000), ['*a*a*a*a*a*a*a*a*a*a*a*a*b'])).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('scope matching, edges', () => {
  it('a trailing ** is everything inside, not the directory name itself', async () => {
    const { inScope } = await import('../src/core/scope');
    expect(inScope('src', ['src/**'])).toBe(false);
    expect(inScope('src/a', ['src/**'])).toBe(true);
    expect(inScope('a/b', ['**/b'])).toBe(true);
    expect(inScope('b', ['**/b'])).toBe(true);
  });
});

describe('checks start once per commit', () => {
  it('a second flow for the same commit leaves it to the first', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    expect(w.engine.beginCheck(w.id, 's1', 'npm test')).toBe(true);
    expect(w.engine.beginCheck(w.id, 's1', 'npm test')).toBe(false);
    w.engine.recordCheck(w.id, 's1', { status: 'passed', exitCode: 0, startedAt: 1, finishedAt: 2 });
    expect(w.engine.beginCheck(w.id, 's1', 'npm test')).toBe(false);
  });

  it('two inspections in flight never move the head back to an older commit', () => {
    const w = setup();
    // The newer commit was seen as the tip later, and is recorded first.
    w.engine.recordPush(w.id, { sha: 'new', ref: 'refs/heads/main', before: null, paths: ['src/rate/a.ts'], isHead: true, seenAt: 2000 });
    const old = w.engine.recordPush(w.id, { sha: 'old', ref: 'refs/heads/main', before: null, paths: ['src/rate/a.ts'], isHead: true, seenAt: 1000 });
    expect(old).toMatchObject({ accepted: false, reason: 'not-head' });
    expect(w.engine.getClaim(w.id).headSha).toBe('new');
  });

  it('only a stale claim re-plans', () => {
    const w = setup();
    expect(() => w.engine.replan(w.id, w.token, { scope: ['**'], restsOn: [] })).toThrow(/not stale/);
  });
});

describe('platform review fixes', () => {
  it('a retried step that already started the checks is told to go on', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    expect(w.engine.beginCheck(w.id, 's1', 'npm test', 'run-1')).toBe(true);
    expect(w.engine.beginCheck(w.id, 's1', 'npm test', 'run-1')).toBe(true);
    expect(w.engine.beginCheck(w.id, 's1', 'npm test', 'run-2')).toBe(false);
  });

  it('keeps at most 500 paths of a huge commit, with the counts', () => {
    const w = setup();
    const paths = Array.from({ length: 1200 }, (_, i) => `vendor/${i}.js`);
    const row = w.push('big', paths);
    expect(row.paths).toHaveLength(500);
    expect(row).toMatchObject({ pathCount: 1200, outsideCount: 1200, verdict: 'scope-violation' });
  });

  it('a landing that could not be started goes back to the queue without using an attempt', () => {
    const w = setup();
    w.push('s1', ['src/rate/a.ts']);
    w.engine.recordCheck(w.id, 's1', { status: 'passed', exitCode: 0, startedAt: 0, finishedAt: 0 });
    w.engine.finish(w.id, w.token);
    const first = w.engine.beginNextLanding('main')!;
    w.engine.abortLanding('main', w.id, first.landing);
    expect(w.engine.getClaim(w.id).landing).toBeUndefined();
    expect(w.engine.beginNextLanding('main')?.claim).toBe(w.id);
  });

  it('the ready list never carries lease tokens', () => {
    const w = setup();
    w.clock.t += 60_001; // the lease lapsed, so the claim is offered again
    const offered = w.engine.readyForDisplay() as { lease?: { token: string } }[];
    expect(offered).toHaveLength(1);
    expect(offered[0]!.lease!.token).toBe('');
  });
});

describe('a change of mode is a change', () => {
  it('making a file executable outside the scope is caught', async () => {
    const { changedPaths } = await import('../src/core/repos');
    const trees: Record<string, { name: string; type: 'tree' | 'blob'; hash: string; mode?: string }[]> = {
      t1: [{ name: 'deploy.sh', type: 'blob', hash: 'b1', mode: '100644' }],
      t2: [{ name: 'deploy.sh', type: 'blob', hash: 'b1', mode: '100755' }],
    };
    const host = {
      readCommit: async (_r: string, sha: string) => ({ sha, tree: sha === 'c1' ? 't1' : 't2', parents: [], message: '' }),
      readTree: async (_r: string, t: string) => trees[t]!,
    } as unknown as import('../src/core/repos').RepoHost;
    expect(await changedPaths(host, 'r', 'c1', 'c2')).toEqual(['deploy.sh']);
  });
});

describe('what agents spend on a claim', () => {
  it('adds up across runs, and ignores nonsense', () => {
    const w = setup();
    w.engine.recordSpend(w.id, { usd: 0.012, turns: 17, model: 'claude-haiku' });
    w.engine.recordSpend(w.id, { usd: 0.008, turns: 9 });
    w.engine.recordSpend(w.id, { usd: Number.NaN, turns: -3 });
    const spend = w.engine.getClaim(w.id).spend!;
    expect(spend).toMatchObject({ turns: 26, runs: 3, model: "claude-haiku" });
    expect(spend.usd).toBeCloseTo(0.02, 6);
  });
});

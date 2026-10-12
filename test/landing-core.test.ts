import { describe, expect, it } from 'vitest';
import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT } from '../src/core/checks';
import { Engine } from '../src/core/engine';
import { landingFromCheck, landingMessage, mergeResult, MERGE_SCRIPT, PROMOTE_SCRIPT } from '../src/core/landing';
import { MemoryStore } from '../src/core/store';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, {
    leaseMs: 60_000, hedgeMs: 300_000, newToken: () => `tok${++n}`, dependencyGate: 'landed', landingTimeoutMs: 600_000,
  });
  const done = (statement: string, requires: string[] = []) => {
    const c = engine.addClaim({ statement, scope: ['**'], requires, orderOverlaps: false });
    const { token } = engine.claim(c.id, 'agent');
    engine.recordPush(c.id, { sha: `sha-${c.id}`, ref: 'refs/heads/main', before: null, paths: ['x'], isHead: true });
    engine.recordCheck(c.id, `sha-${c.id}`, { status: 'passed', exitCode: 0, startedAt: 0, finishedAt: 0 });
    engine.finish(c.id, token);
    clock.t += 1000;
    return c.id;
  };
  return { engine, clock, done };
}

describe('the landing queue', () => {
  it('lands one claim at a time per line, oldest first', () => {
    const w = setup();
    const a = w.done('a');
    w.done('b');
    const first = w.engine.beginNextLanding('main');
    expect(first).toMatchObject({ claim: a, sha: `sha-${a}` });
    expect(w.engine.beginNextLanding('main')).toBeNull();
    w.engine.completeLanding('main', a, { status: 'landed', merge: 'm1' }, first!.landing);
    expect(w.engine.beginNextLanding('main')?.claim).toBe('c2');
    expect(w.engine.line('main')).toMatchObject({ head: 'm1', served: true });
  });

  it('a claim waits for what it builds on to land, even if it finished first', () => {
    const w = setup();
    const c = w.engine.addClaim({ statement: 'first', scope: ['**'], orderOverlaps: false });
    const { token } = w.engine.claim(c.id, 'a');
    // Under the landed gate a dependent is not ready until c lands, so build
    // the order by hand: the dependent finishes before its dependency does.
    const d = w.engine.addClaim({ statement: 'second', scope: ['**'], requires: [c.id], orderOverlaps: false });
    expect(w.engine.isReady(d.id)).toBe(false);
    w.engine.finish(c.id, token);
    expect(w.engine.beginNextLanding('main')).toEqual(null); // no commits: landed as is
    expect(w.engine.getClaim(c.id).status).toBe('landed');
    expect(w.engine.isReady(d.id)).toBe(true);
  });

  it('a landing that never reports back is given up on and retried, and its late report is ignored', () => {
    const w = setup();
    const a = w.done('a');
    w.done('b');
    const abandoned = w.engine.beginNextLanding('main')!;
    w.clock.t += 600_001;
    const retry = w.engine.beginNextLanding('main')!;
    expect(retry).toMatchObject({ claim: a });
    expect(retry.landing).not.toBe(abandoned.landing);
    expect(w.engine.completeLanding('main', a, { status: 'landed', merge: 'late' }, abandoned.landing)).toBe(false);
    expect(w.engine.completeLanding('main', a, { status: 'landed', merge: 'm1' }, retry.landing)).toBe(true);
    expect(w.engine.getClaim(a)).toMatchObject({ status: 'landed', landedSha: 'm1' });
  });

  it('platform errors are retried up to three attempts; conflicts are not', () => {
    const w = setup();
    const a = w.done('a');
    const b = w.done('b');
    for (let i = 0; i < 3; i++) {
      const l = w.engine.beginNextLanding('main')!;
      expect(l.claim).toBe(a);
      w.engine.completeLanding('main', a, { status: 'error', log: 'no container' }, l.landing);
    }
    const next = w.engine.beginNextLanding('main')!;
    expect(next.claim).toBe(b);
    w.engine.completeLanding('main', b, { status: 'conflict', files: ['x'] }, next.landing);
    expect(w.engine.beginNextLanding('main')).toBeNull();
    expect(w.engine.getClaim(a).landing).toMatchObject({ status: 'error', attempts: 3 });
  });
});

describe('reading a landing\'s outcome', () => {
  it('finds the merge commit, the conflicting files, and the platform failing', () => {
    const merge = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    expect(mergeResult({ exitCode: 0, stdout: `BASE ${base}\nMERGED ${merge}\n`, stderr: '', ms: 1 })).toMatchObject({ status: 'merged', merge, base });
    expect(mergeResult({ exitCode: EXIT_MERGE_CONFLICT, stdout: `BASE ${base}\nCONFLICT\nsrc/a.ts\nsrc/b.ts\n`, stderr: '', ms: 1 }))
      .toMatchObject({ status: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
    expect(mergeResult({ exitCode: EXIT_FETCH_FAILED, stdout: '', stderr: '', ms: 1 }).status).toBe('error');
    expect(mergeResult({ exitCode: null, stdout: '', stderr: '', ms: 1, error: 'boom' }).status).toBe('error');
    expect(landingFromCheck({ status: 'failed', exitCode: 1, startedAt: 0, log: 'not ok 1' })).toMatchObject({ status: 'failed' });
    expect(landingFromCheck({ status: 'timeout', exitCode: 124, startedAt: 0 })).toMatchObject({ status: 'failed' });
    expect(landingFromCheck({ status: 'passed', exitCode: 0, startedAt: 0 })).toBeNull();
  });

  it('never runs repo code where a token that can write the line exists', () => {
    // The merge and the promotion run no repo code (no setup, no checks, no
    // hooks); the checks run elsewhere with a read token, dropped first.
    for (const script of [MERGE_SCRIPT, PROMOTE_SCRIPT]) {
      expect(script).not.toMatch(/\$SETUP|\$CHECK|npm|node /);
      expect(script).toContain('core.hooksPath /dev/null');
    }
    expect(PROMOTE_SCRIPT).toContain('"$MERGE:refs/heads/main"');
  });

  it('the merge commit names its claim', () => {
    expect(landingMessage('c12', 'Rate limits  live\nin a Durable Object')).toBe('Land c12: Rate limits live in a Durable Object\n\nSuperpose-Claim: c12');
  });
});

describe('giving up on a stuck landing', () => {
  it('unlocks the line and puts the claim back in the queue as a failed attempt', () => {
    const w = setup();
    const a = w.done('a');
    w.engine.beginNextLanding('main');
    expect(w.engine.abandonLanding('main')).toBe(a);
    expect(w.engine.getClaim(a).landing).toMatchObject({ status: 'error', attempts: 1 });
    expect(w.engine.beginNextLanding('main')?.claim).toBe(a);
  });
});

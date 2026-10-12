import { describe, expect, it } from 'vitest';
import { EXIT_FETCH_FAILED, EXIT_MERGE_CONFLICT } from '../src/core/checks';
import { Engine } from '../src/core/engine';
import { landingMessage, landingOutcome } from '../src/core/landing';
import { MemoryStore } from '../src/core/store';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, {
    leaseMs: 60_000, hedgeMs: 300_000, newToken: () => `tok${++n}`, dependencyGate: 'landed', landingTimeoutMs: 600_000,
  });
  const done = (statement: string, requires: string[] = []) => {
    const c = engine.addClaim({ statement, scope: ['**'], requires });
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
    expect(w.engine.beginNextLanding('main')).toEqual({ claim: a, sha: `sha-${a}` });
    expect(w.engine.beginNextLanding('main')).toBeNull();
    w.engine.completeLanding('main', a, { status: 'landed', merge: 'm1' });
    expect(w.engine.beginNextLanding('main')?.claim).toBe('c2');
    expect(w.engine.line('main')).toMatchObject({ head: 'm1', served: true });
  });

  it('a claim waits for what it builds on to land, even if it finished first', () => {
    const w = setup();
    const c = w.engine.addClaim({ statement: 'first', scope: ['**'] });
    const { token } = w.engine.claim(c.id, 'a');
    // Under the landed gate a dependent is not ready until c lands, so build
    // the order by hand: the dependent finishes before its dependency does.
    const d = w.engine.addClaim({ statement: 'second', scope: ['**'], requires: [c.id] });
    expect(w.engine.isReady(d.id)).toBe(false);
    w.engine.finish(c.id, token);
    expect(w.engine.beginNextLanding('main')).toEqual(null); // no commits: landed as is
    expect(w.engine.getClaim(c.id).status).toBe('landed');
    expect(w.engine.isReady(d.id)).toBe(true);
  });

  it('a landing that never reports back is given up on, and the queue moves on', () => {
    const w = setup();
    const a = w.done('a');
    const b = w.done('b');
    w.engine.beginNextLanding('main');
    w.clock.t += 600_001;
    expect(w.engine.beginNextLanding('main')).toEqual({ claim: b, sha: `sha-${b}` });
    expect(w.engine.getClaim(a).landing).toMatchObject({ status: 'error' });
  });
});

describe('reading a landing\'s outcome', () => {
  it('finds the merge commit, the conflicting files, and the platform failing', () => {
    const merge = 'a'.repeat(40);
    expect(landingOutcome({ exitCode: 0, stdout: `ok\nMERGED ${merge}\n`, stderr: '', ms: 1 })).toMatchObject({ status: 'landed', merge });
    expect(landingOutcome({ exitCode: EXIT_MERGE_CONFLICT, stdout: 'CONFLICT\nsrc/a.ts\nsrc/b.ts\n', stderr: '', ms: 1 }))
      .toMatchObject({ status: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
    expect(landingOutcome({ exitCode: 1, stdout: 'not ok 1', stderr: '', ms: 1 }).status).toBe('failed');
    expect(landingOutcome({ exitCode: EXIT_FETCH_FAILED, stdout: '', stderr: '', ms: 1 }).status).toBe('error');
    expect(landingOutcome({ exitCode: null, stdout: '', stderr: '', ms: 1, error: 'boom' }).status).toBe('error');
  });

  it('the merge commit names its claim', () => {
    expect(landingMessage('c12', 'Rate limits  live\nin a Durable Object')).toBe('Land c12: Rate limits live in a Durable Object\n\nSuperpose-Claim: c12');
  });
});

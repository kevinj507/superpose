import { beforeEach, describe, expect, it } from 'vitest';
import { Engine, EngineError } from '../src/core/engine';
import { MemoryStore } from '../src/core/store';
import { inScope } from '../src/core/scope';

const LEASE = 60_000;
const HEDGE = 300_000;

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, {
    leaseMs: LEASE,
    hedgeMs: HEDGE,
    newToken: () => `tok${++n}`,
  });
  return { engine, clock };
}

// 100 claims. Assumption A carries 12 of them: 9 directly (d1..d9) and 3
// that build on d1..d3 (i1..i3). Assumption B carries the other 88 (o1..o88).
// d1..d3 are finished so i1..i3 can start; everything else is in progress.
function hundredClaims() {
  const { engine, clock } = setup();
  const A = engine.addAssumption('the date library handles time zones');
  const B = engine.addAssumption('requests are authenticated upstream');
  const tokens = new Map<string, string>();
  const direct = Array.from({ length: 9 }, (_, i) =>
    engine.addClaim({ statement: `direct ${i + 1}`, scope: [`src/d${i + 1}/**`], restsOn: [A.id] }),
  );
  const others = Array.from({ length: 88 }, (_, i) =>
    engine.addClaim({ statement: `other ${i + 1}`, scope: [`src/o${i + 1}/**`], restsOn: [B.id] }),
  );
  for (const c of [...direct, ...others]) tokens.set(c.id, engine.claim(c.id, `agent-${c.id}`).token);
  for (const c of direct) engine.push(c.id, tokens.get(c.id)!, { sha: `sha-${c.id}`, changedPaths: [`src/d${c.id}/x.ts`] });
  for (const c of direct.slice(0, 3)) engine.finish(c.id, tokens.get(c.id)!);
  const indirect = direct.slice(0, 3).map((d, i) =>
    engine.addClaim({ statement: `indirect ${i + 1}`, scope: [`src/i${i + 1}/**`], requires: [d.id] }),
  );
  for (const c of indirect) tokens.set(c.id, engine.claim(c.id, `agent-${c.id}`).token);
  const twelve = [...direct, ...indirect].map((c) => c.id);
  const eightyEight = others.map((c) => c.id);
  const finder = others[49]!.id;
  return { engine, clock, A, B, tokens, twelve, eightyEight, finder, direct, indirect };
}

describe('scoping', () => {
  it('a verified finding marks exactly the 12 claims resting on the assumption, directly or not', () => {
    const w = hundredClaims();
    const { finding } = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'The date library drops time zones',
      effect: 'contradicts',
      targets: [w.A.id],
    });
    const impact = w.engine.verifyFinding(finding.id);
    expect(impact.affected.sort()).toEqual([...w.twelve].sort());
    const stale = w.engine.claims().filter((c) => c.status === 'stale').map((c) => c.id);
    expect(stale.sort()).toEqual([...w.twelve].sort());
    for (const id of w.eightyEight) expect(w.engine.node(id)).toMatchObject({ status: 'claimed' });
  });
});

describe('the hedge', () => {
  let w: ReturnType<typeof hundredClaims>;
  let findingId: string;
  beforeEach(() => {
    w = hundredClaims();
    findingId = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'The date library drops time zones',
      effect: 'contradicts',
      targets: [w.A.id],
    }).finding.id;
  });

  it('an unverified finding stops nobody and only the finder hears of it', () => {
    for (const id of w.twelve) expect(w.engine.node(id)).not.toMatchObject({ status: 'stale' });
    for (const id of [...w.twelve, ...w.eightyEight].filter((id) => id !== w.finder)) {
      const c = w.engine.node(id) as { status: string };
      if (c.status !== 'claimed') continue;
      const r = w.engine.renew(id, w.tokens.get(id)!);
      expect(r.ok).toBe(true);
      expect(r.notices).toEqual([]);
    }
    const mine = w.engine.renew(w.finder, w.tokens.get(w.finder)!);
    expect(mine.notices.map((n) => n.type)).toEqual(['finding.filed']);
  });

  it('refuting parks the finder\'s work, touches no one else, and is remembered', () => {
    w.engine.push(w.finder, w.tokens.get(w.finder)!, { sha: 'hedge-sha', changedPaths: ['src/o50/a.ts'] });
    w.engine.refuteFinding(findingId);
    expect(w.engine.node(w.finder)).toMatchObject({
      status: 'stale',
      kept: [{ sha: 'hedge-sha', reason: `finding ${findingId} refuted` }],
    });
    expect(w.engine.claims().filter((c) => c.status === 'stale')).toHaveLength(1);
    expect(w.engine.node(w.A.id)).toMatchObject({ status: 'holding' });

    const other = w.eightyEight[0]!;
    const again = w.engine.fileFinding(other, w.tokens.get(other)!, {
      statement: 'the date library DROPS time-zones.',
      effect: 'contradicts',
      targets: [w.A.id],
    });
    expect(again.duplicate).toBe(true);
    expect(again.finding).toMatchObject({ id: findingId, status: 'refuted' });
  });

  it('a finding left unverified past its window asks for a decision, once, and still stops nobody', () => {
    w.clock.t += HEDGE + 1;
    expect(w.engine.expireHedges().map((f) => f.id)).toEqual([findingId]);
    w.engine.expireHedges();
    const expired = w.engine.events().filter((e) => e.type === 'finding.hedge_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.claims).toEqual([w.finder]);
    expect(w.engine.claims().filter((c) => c.status === 'stale')).toHaveLength(0);
  });
});

describe('delivery at lease renewal', () => {
  it('the affected agents are told at their next renewal; the others hear nothing', () => {
    const w = hundredClaims();
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    w.engine.verifyFinding(f.id);
    const leased = w.twelve.filter((id) => w.tokens.has(id) && !w.direct.slice(0, 3).some((d) => d.id === id));
    expect(leased).toHaveLength(9);
    for (const id of leased) {
      const r = w.engine.renew(id, w.tokens.get(id)!);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('stale');
      expect(r.notices.map((n) => n.type)).toEqual(['claim.stale']);
      expect(r.notices[0]!.data).toMatchObject({ finding: f.id, assumptions: [w.A.id] });
    }
    for (const id of w.eightyEight.filter((id) => id !== w.finder)) {
      const r = w.engine.renew(id, w.tokens.get(id)!);
      expect(r).toMatchObject({ ok: true, notices: [] });
    }
  });

  it('a notice is delivered once', () => {
    const w = hundredClaims();
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    w.engine.verifyFinding(f.id);
    const id = w.direct[5]!.id;
    expect(w.engine.renew(id, w.tokens.get(id)!).notices).toHaveLength(1);
    expect(w.engine.renew(id, w.tokens.get(id)!).notices).toHaveLength(0);
  });
});

describe('teeth', () => {
  it('a stale claim cannot push, and its lease is not extended until it re-plans', () => {
    const w = hundredClaims();
    const C = w.engine.addAssumption('timestamps are stored in UTC and converted at the edge');
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    w.engine.verifyFinding(f.id);
    const id = w.direct[6]!.id;
    const token = w.tokens.get(id)!;
    expect(w.engine.push(id, token, { sha: 'x', changedPaths: ['src/d7/y.ts'] })).toEqual({ accepted: false, reason: 'stale' });

    const before = (w.engine.node(id) as { lease: { expiresAt: number } }).lease.expiresAt;
    w.clock.t += 1000;
    w.engine.renew(id, token);
    expect((w.engine.node(id) as { lease: { expiresAt: number } }).lease.expiresAt).toBe(before);

    expect(() => w.engine.replan(id, token, { restsOn: [w.A.id] })).toThrow(EngineError);
    w.engine.replan(id, token, { restsOn: [C.id] });
    expect(w.engine.node(id)).toMatchObject({ status: 'claimed', version: 2 });
    expect(w.engine.renew(id, token).ok).toBe(true);
    expect(w.engine.push(id, token, { sha: 'y', changedPaths: ['src/d7/y.ts'] }).accepted).toBe(true);
  });
});

describe('kept work and cost', () => {
  it('the work done before the finding is kept, and the cost is known before it fires', () => {
    const w = hundredClaims();
    const t = (id: string) => w.tokens.get(id)!;
    w.engine.push(w.direct[4]!.id, t(w.direct[4]!.id), { sha: 'second', changedPaths: ['src/d5/z.ts'] });
    const f = w.engine.fileFinding(w.finder, t(w.finder), {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    // d1..d9 pushed once each, d5 twice; i1..i3 not at all.
    expect(w.engine.impactOf(f.id)).toMatchObject({ cost: 10, landedAtRisk: [] });
    w.engine.verifyFinding(f.id);
    expect(w.engine.node(w.direct[4]!.id)).toMatchObject({ kept: [{ sha: 'second' }] });
    expect(w.engine.node(w.indirect[0]!.id)).toMatchObject({ status: 'stale', kept: [] });
  });

  it('landed claims are reported as the served reality at risk, not marked stale', () => {
    const w = hundredClaims();
    w.engine.land(w.direct[0]!.id);
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    const impact = w.engine.verifyFinding(f.id);
    expect(impact.landedAtRisk).toEqual([w.direct[0]!.id]);
    expect(impact.affected).toHaveLength(11);
    expect(w.engine.node(w.direct[0]!.id)).toMatchObject({ status: 'landed' });
  });
});

describe('races', () => {
  it('a finding verified between a renewal and a push makes the push fail', () => {
    const w = hundredClaims();
    const id = w.direct[7]!.id;
    expect(w.engine.renew(id, w.tokens.get(id)!).ok).toBe(true);
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, {
      statement: 'tz bug', effect: 'contradicts', targets: [w.A.id],
    }).finding;
    w.engine.verifyFinding(f.id);
    expect(w.engine.push(id, w.tokens.get(id)!, { sha: 'late', changedPaths: ['src/d8/a.ts'] }).accepted).toBe(false);
  });

  it('a second finding on the same assumption does not notify anyone twice', () => {
    const w = hundredClaims();
    const t = (id: string) => w.tokens.get(id)!;
    const f1 = w.engine.fileFinding(w.finder, t(w.finder), { statement: 'tz bug', effect: 'contradicts', targets: [w.A.id] }).finding;
    const other = w.eightyEight[1]!;
    const f2 = w.engine.fileFinding(other, t(other), { statement: 'dst bug too', effect: 'contradicts', targets: [w.A.id] }).finding;
    w.engine.verifyFinding(f1.id);
    w.engine.verifyFinding(f2.id);
    const id = w.direct[8]!.id;
    expect(w.engine.renew(id, t(id)).notices.filter((n) => n.type === 'claim.stale')).toHaveLength(1);
  });

  it('a finding against an assumption nobody rests on any more affects nobody', () => {
    const w = hundredClaims();
    const t = (id: string) => w.tokens.get(id)!;
    const Z = w.engine.addAssumption('cache is per-request');
    const only = w.engine.addClaim({ statement: 'z', scope: ['src/z/**'], restsOn: [Z.id] });
    const tok = w.engine.claim(only.id, 'agent-z').token;
    // A first finding against Z makes the claim stale; it re-plans onto B.
    const first = w.engine.fileFinding(w.finder, t(w.finder), { statement: 'cache is shared', effect: 'contradicts', targets: [Z.id] }).finding;
    w.engine.verifyFinding(first.id);
    w.engine.replan(only.id, tok, { restsOn: [w.B.id] });
    const f = w.engine.fileFinding(w.finder, t(w.finder), { statement: 'cache leaks', effect: 'contradicts', targets: [Z.id] }).finding;
    expect(w.engine.verifyFinding(f.id).affected).toEqual([]);
  });
});

describe('helpful findings', () => {
  it('reach only the claims they support, as advice, and stop nobody', () => {
    const w = hundredClaims();
    const t = (id: string) => w.tokens.get(id)!;
    const targets = [w.eightyEight[2]!, w.eightyEight[3]!];
    const f = w.engine.fileFinding(w.finder, t(w.finder), {
      statement: 'there is a ready-made retry helper in lib/retry', effect: 'helps', targets,
    }).finding;
    w.engine.verifyFinding(f.id);
    for (const id of targets) {
      const r = w.engine.renew(id, t(id));
      expect(r.ok).toBe(true);
      expect(r.notices.map((n) => n.type)).toEqual(['claim.helped']);
    }
    expect(w.engine.renew(w.eightyEight[4]!, t(w.eightyEight[4]!)).notices).toEqual([]);
    expect(w.engine.claims().filter((c) => c.status === 'stale')).toHaveLength(0);
  });
});

describe('claims, readiness and scope', () => {
  it('a claim is ready only when what it builds on is finished and what it rests on holds', () => {
    const { engine } = setup();
    const A = engine.addAssumption('a');
    const first = engine.addClaim({ statement: 'first', scope: ['a/**'], restsOn: [A.id] });
    const second = engine.addClaim({ statement: 'second', scope: ['b/**'], requires: [first.id] });
    expect(engine.ready().map((c) => c.id)).toEqual([first.id]);
    expect(() => engine.claim(second.id, 'x')).toThrow(EngineError);
    const tok = engine.claim(first.id, 'x').token;
    engine.finish(first.id, tok);
    expect(engine.ready().map((c) => c.id)).toEqual([second.id]);
  });

  it('an expired lease can be taken over, and the old token stops working', () => {
    const { engine, clock } = setup();
    const c = engine.addClaim({ statement: 'c', scope: ['c/**'] });
    const old = engine.claim(c.id, 'first-agent').token;
    clock.t += LEASE + 1;
    const fresh = engine.claim(c.id, 'second-agent').token;
    expect(() => engine.renew(c.id, old)).toThrow(EngineError);
    expect(engine.renew(c.id, fresh).ok).toBe(true);
  });

  it('a push outside the declared scope is recorded and flagged with the paths', () => {
    const { engine } = setup();
    const c = engine.addClaim({ statement: 'upload limits', scope: ['src/upload/**', 'test/upload.test.ts'] });
    const tok = engine.claim(c.id, 'x').token;
    expect(engine.push(c.id, tok, { sha: '1', changedPaths: ['src/upload/limits.ts', 'src/upload/deep/a.ts'] }))
      .toEqual({ accepted: true, verdict: 'in-scope', outside: [] });
    expect(engine.push(c.id, tok, { sha: '2', changedPaths: ['src/upload/limits.ts', 'package.json'] }))
      .toEqual({ accepted: true, verdict: 'scope-violation', outside: ['package.json'] });
  });

  it('scope patterns: ** spans directories, * stays within one', () => {
    expect(inScope('src/a/b/c.ts', ['src/**'])).toBe(true);
    expect(inScope('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(inScope('src/a/b.ts', ['src/*.ts'])).toBe(false);
    expect(inScope('src.ts', ['src/**'])).toBe(false);
  });
});

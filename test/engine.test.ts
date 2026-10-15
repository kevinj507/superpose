import { beforeEach, describe, expect, it } from 'vitest';
import { Engine, EngineError } from '../src/core/engine';
import { MemoryStore } from '../src/core/store';
import { inScope } from '../src/core/scope';

const LEASE = 60_000;
const HEDGE = 300_000;

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const store = new MemoryStore();
  const engine = new Engine(store, clock, {
    leaseMs: LEASE,
    hedgeMs: HEDGE,
    newToken: () => `tok${++n}`,
  });
  return { engine, clock, store };
}

// 100 claims. Assumption A carries 12 of them: 9 directly (d1..d9) and 3
// that build on d1..d3 (i1..i3). Assumption B carries the other 88 (o1..o88).
// d1..d3 are finished so i1..i3 can start; everything else is in progress.
function hundredClaims() {
  const { engine, clock, store } = setup();
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
  return { engine, clock, store, A, B, tokens, twelve, eightyEight, finder, direct, indirect };
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

describe('owner external checks', () => {
  const binding = { incident_id: 'job-17', workload_digest: 'workload-sha256', code_sha: 'code-sha', config_revision: 'cfg-9', trace_digest: 'trace-sha256', verifier_version: 'challenge-v1' };
  it('stales both the affected finder and dependent claim on a checked contradiction, preserving independent work', () => {
    const w = hundredClaims();
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, { statement: 'capacity caused the incident, not budget', effect: 'contradicts', targets: [w.A.id], where: [w.finder, w.direct[0]!.id] }).finding;
    const independent = w.eightyEight[0]!;
    const impact = w.engine.recordExternalCheck(f.id, { status: 'confirmed', binding, reason: 'Replay matches the applied capacity policy.', probes: ['capacity isolated', 'budget calculation unchanged'] });
    expect(impact?.affected.sort()).toEqual([w.finder, w.direct[0]!.id].sort());
    expect(w.engine.node(w.finder)).toMatchObject({ status: 'stale' });
    expect(w.engine.node(w.direct[0]!.id)).toMatchObject({ status: 'stale' });
    expect(w.engine.node(independent)).toMatchObject({ status: 'claimed' });
    expect(w.engine.node(f.id)).toMatchObject({ status: 'verified', externalEvidence: { status: 'confirmed', binding } });
  });

  it('records inconclusive provenance without settling, and explicit refutation settles without propagation', () => {
    const w = hundredClaims();
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, { statement: 'capacity caused incident', effect: 'contradicts', targets: [w.A.id], where: [w.finder] }).finding;
    w.engine.recordExternalCheck(f.id, { status: 'inconclusive', binding, reason: 'Trace ambiguous.', probes: ['replay ambiguous'] });
    expect(w.engine.node(f.id)).toMatchObject({ status: 'unverified', externalEvidence: { status: 'inconclusive' } });
    expect(w.engine.node(w.finder)).toMatchObject({ status: 'claimed' });
    const g = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, { statement: 'second capacity clue', effect: 'contradicts', targets: [w.A.id], where: [w.finder] }).finding;
    w.engine.recordExternalCheck(g.id, { status: 'refuted', binding, reason: 'Wrong configuration revision.', probes: ['revision mismatch'] });
    expect(w.engine.node(g.id)).toMatchObject({ status: 'refuted', externalEvidence: { status: 'refuted' } });
    expect(w.engine.node(w.finder)).toMatchObject({ status: 'claimed' });
  });

  it('rejects incomplete external bindings', () => {
    const w = hundredClaims();
    const f = w.engine.fileFinding(w.finder, w.tokens.get(w.finder)!, { statement: 'capacity caused incident', effect: 'contradicts', targets: [w.A.id], where: [w.finder] }).finding;
    expect(() => w.engine.recordExternalCheck(f.id, { status: 'confirmed', binding: { ...binding, code_sha: '' }, reason: 'checked', probes: [] })).toThrow(EngineError);
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

  it('remembers refutation without treating a report as speculative work', () => {
    w.engine.push(w.finder, w.tokens.get(w.finder)!, { sha: 'hedge-sha', changedPaths: ['src/o50/a.ts'] });
    w.engine.refuteFinding(findingId);
    expect(w.engine.node(w.finder)).toMatchObject({
      status: 'claimed',
      kept: [],
    });
    expect(w.engine.claims().filter((c) => c.status === 'stale')).toHaveLength(0);
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
  it('a live holder can stop relying on an uncertain premise without verifying it for everyone', () => {
    const w = hundredClaims(), id = w.direct[6]!.id, token = w.tokens.get(id)!;
    const replacement = w.engine.addAssumption('Use the current admission evidence');
    const finding = w.engine.fileFinding(id, token, {statement:'The old contract may have changed',effect:'contradicts',targets:[w.A.id]}).finding;
    const before = w.engine.getClaim(id);
    w.engine.replan(id, token, {restsOn:[replacement.id]});
    expect(w.engine.getClaim(id)).toMatchObject({status:'claimed',version:before.version+1,scope:before.scope,statement:before.statement});
    expect(w.engine.node(finding.id)).toMatchObject({status:'unverified'});
    expect(w.engine.node(w.A.id)).toMatchObject({status:'holding'});
    expect(w.engine.getClaim(w.direct[5]!.id).status).toBe('claimed');
    expect(w.store.edgesTo(id,'required for').map(e=>e.source)).toContain(replacement.id);
    expect(w.store.edgesTo(id,'required for').map(e=>e.source)).not.toContain(w.A.id);
    expect(w.store.edgesFrom(id,'supersedes')).toHaveLength(1);
    expect(()=>w.engine.replan(id,token,{restsOn:[],scope:['**']})).toThrow(/scope remain frozen/);
  });

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

  it('filed for a claim nobody holds yet, they reach whoever takes it first', () => {
    const { engine } = setup();
    const finder = engine.addClaim({ statement: 'pricing', scope: ['src/pricing.js'] });
    const open = engine.addClaim({ statement: 'pages', scope: ['src/pages.js'] });
    const finderToken = engine.claim(finder.id, 'agent-1').token;
    const f = engine.fileFinding(finder.id, finderToken, {
      statement: 'a cached page keeps showing the old price after a buy', effect: 'helps', targets: [open.id],
    }).finding;
    engine.verifyFinding(f.id);
    const token = engine.claim(open.id, 'agent-2').token;
    const r = engine.renew(open.id, token);
    expect(r.ok).toBe(true);
    expect(r.notices.map((n) => n.type)).toEqual(['claim.helped']);
    expect(r.notices[0]!.data).toMatchObject({ finding: f.id });
    // Heard once: the next renewal carries nothing new.
    expect(engine.renew(open.id, token).notices).toEqual([]);
  });
});

// The constitution and the gate on pairs: what the pricing test (graph
// shop-sp-1, 2026-10-13) showed was missing. Two claims each true to their
// statement and tested, wrong together; nothing in the plan said what the
// product keeps, so nothing could be checked against it.
describe('the constitution and the gate on pairs', () => {
  const passed = { status: 'passed' as const, exitCode: 0, startedAt: 0, finishedAt: 0 };
  function shop() {
    const clock = { t: 1_000_000, now() { return this.t; } };
    let n = 0;
    const store = new MemoryStore();
    const engine = new Engine(store, clock, { leaseMs: LEASE, hedgeMs: HEDGE, newToken: () => `tok${++n}`, dependencyGate: 'landed', landingTimeoutMs: 600_000 });
    store.putLine({ ...engine.line('main'), repo: { name: 'g.line.main', remote: 'x' } });
    const article = engine.addAssumption('What you see is what you pay', { constitution: true, check: 'node --test constitution/see-is-pay.test.js' });
    const judged = engine.addAssumption('Prices are never surprising', { constitution: true });
    const c2 = engine.addClaim({ statement: 'pages are cached for 60 s', scope: ['src/pages.js'], orderOverlaps: false });
    const c3 = engine.addClaim({ statement: 'prices move with demand', scope: ['src/pricing.js'], orderOverlaps: false });
    const push = (id: string, sha: string, paths: string[]) => {
      engine.recordPush(id, { sha, ref: 'refs/heads/main', before: null, paths, isHead: true });
      engine.recordCheck(id, sha, passed);
    };
    const land = (id: string, token: string, merge: string) => {
      engine.finish(id, token);
      const landing = engine.beginNextLanding('main')!;
      engine.completeLanding('main', id, { status: 'landed', merge }, landing.landing);
      clock.t += 1000;
    };
    return { engine, store, clock, article, judged, c2, c3, push, land };
  }

  it('articles are listed, run when they have a check, and block no claim', () => {
    const w = shop();
    expect(w.engine.constitution().map((a) => a.id)).toEqual([w.article.id, w.judged.id]);
    expect(w.engine.isReady(w.c2.id)).toBe(true);
    expect(w.engine.isReady(w.c3.id)).toBe(true);
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    expect(w.engine.pairContext(w.c2.id)).toMatchObject({ skip: expect.stringContaining('no repo') });
    w.engine.attachRepo(w.c2.id, t2, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    const ctx = w.engine.pairContext(w.c2.id);
    expect(ctx).toMatchObject({ articles: [{ id: w.article.id, check: 'node --test constitution/see-is-pay.test.js' }], candidates: [] });
  });

  it('a broken pair files the gate\'s own finding, stales only the claims in it, and nothing finishes until it holds again', () => {
    const w = shop();
    // c2 forks at the seed; c3 lands after.
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    w.engine.attachRepo(w.c2.id, t2, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    const t3 = w.engine.claim(w.c3.id, 'a3').token;
    w.engine.attachRepo(w.c3.id, t3, { name: 'g.claim.c3', remote: 'z' }, 'seed');
    w.push(w.c3.id, 'sha3', ['src/pricing.js']);
    w.land(w.c3.id, t3, 'm3');
    expect(w.engine.pairContext(w.c2.id)).toMatchObject({ candidates: [{ claim: w.c3.id, merge: 'm3' }] });

    w.push(w.c2.id, 'sha2', ['src/pages.js']);
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-1')).toBe(true);
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-1')).toBe(true); // the same run asking again
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-2')).toBe(false);
    w.engine.recordPair(w.c2.id, 'sha2', {
      status: 'broken', lineHead: 'm3', merge: 'p1', broken: [w.article.id], partner: w.c3.id,
      log: 'ARTICLE pair a1 BROKEN\nBROKEN a1\n--- a1\nnot ok 1 - what you see is what you pay\n  error: \'purchase 2 of lamp charged $42.00, but its page showed $40.00 just before it\'\nPARTNER c2',
      startedAt: 0, finishedAt: 1,
    });
    const f = w.engine.findings().find((x) => x.finder === 'gate')!;
    expect(f).toMatchObject({ status: 'verified', effect: 'contradicts', targets: [w.article.id], where: [w.c2.id, w.c3.id] });
    expect(f.statement).toContain(`is false where ${w.c2.id} at sha2 and ${w.c3.id} are together`);
    expect(f.statement).toContain('purchase 2 of lamp charged $42.00, but its page showed $40.00');
    expect(f.statement).not.toContain('error:');
    // The article is false only in the pair: it still holds, and c3's landed work is at risk, not undone.
    expect(w.engine.node(w.article.id)).toMatchObject({ status: 'holding' });
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'stale' });
    expect(w.engine.node(w.c3.id)).toMatchObject({ status: 'landed' });
    const events = w.engine.events();
    expect(events.find((e) => e.type === 'claim.pair_checked')).toMatchObject({ claims: [w.c2.id], data: { status: 'broken', partner: w.c3.id, current: true } });
    expect(events.find((e) => e.type === 'claim.stale')).toMatchObject({ claims: [w.c2.id], data: { constitution: true, where: [w.c2.id, w.c3.id], assumptions: [w.article.id] } });
    expect(events.find((e) => e.type === 'reality.at_risk')).toMatchObject({ claims: [w.c3.id], data: { where: [w.c2.id, w.c3.id] } });
    expect(w.engine.impactOf(f.id)).toMatchObject({ affected: [w.c2.id], landedAtRisk: [w.c3.id] });
    // The same break reported again is not a second finding.
    w.engine.recordPair(w.c2.id, 'sha2', { ...w.engine.pushRecord(w.c2.id, 'sha2')!.pair!, status: 'broken' });
    expect(w.engine.findings().filter((x) => x.finder === 'gate')).toHaveLength(1);
    // Re-planned, the claim is live again, but the head still breaks the pair: it cannot finish.
    w.engine.replan(w.c2.id, t2, { restsOn: [] });
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'claimed' });
    expect(() => w.engine.finish(w.c2.id, t2)).toThrow(/constitution/);
    // A fix: the pair holds on the new commit, the gate's finding is resolved, and the claim finishes.
    w.push(w.c2.id, 'sha2b', ['src/pages.js']);
    w.engine.recordPair(w.c2.id, 'sha2b', { status: 'passed', lineHead: 'm3', merge: 'p2', startedAt: 0, finishedAt: 1 });
    expect(w.engine.node(f.id)).toMatchObject({ status: 'resolved' });
    expect(w.engine.events().find((e) => e.type === 'reality.restored')).toMatchObject({ claims: [w.c3.id], data: { finding: f.id, by: w.c2.id } });
    expect(() => w.engine.finish(w.c2.id, t2)).not.toThrow();
  });

  it('an existing line failure waits without staling unrelated work, then rechecks and permits completion', () => {
    const w = shop();
    const token = w.engine.claim(w.c2.id, 'independent').token;
    w.engine.attachRepo(w.c2.id, token, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    w.push(w.c2.id, 'unchanged', ['src/pages.js']);
    w.engine.recordPair(w.c2.id, 'unchanged', { status: 'blocked', baselineBroken: [w.article.id], lineHead: null, startedAt: 0, finishedAt: 1 });
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'claimed', headSha: 'unchanged' });
    expect(w.engine.findings()).toHaveLength(0);
    expect(() => w.engine.finish(w.c2.id, token)).toThrow(/shared line/);
    const repairToken = w.engine.claim(w.c3.id, 'repair').token;
    w.engine.attachRepo(w.c3.id, repairToken, { name: 'g.claim.c3', remote: 'z' }, 'seed');
    w.push(w.c3.id, 'repair', ['src/pricing.js']);
    w.land(w.c3.id, repairToken, 'repaired-line');
    expect(w.engine.pairRechecks('main')).toContainEqual({ claim: w.c2.id, sha: 'unchanged', repo: 'g.claim.c2' });
    w.engine.recordPair(w.c2.id, 'unchanged', { status: 'passed', lineHead: 'repaired-line', startedAt: 2, finishedAt: 3 });
    expect(() => w.engine.finish(w.c2.id, token)).not.toThrow();
  });

  it('a landing makes every in-flight head on the line due for a pair check again', () => {
    const w = shop();
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    w.engine.attachRepo(w.c2.id, t2, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    w.push(w.c2.id, 'sha2', ['src/pages.js']);
    // Paired with the seed: nothing to pair with, the article holds.
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-1')).toBe(true);
    w.engine.recordPair(w.c2.id, 'sha2', { status: 'passed', lineHead: null, startedAt: 0, finishedAt: 1 });
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-2')).toBe(false); // judged against this line already
    expect(w.engine.pairRechecks('main')).toEqual([]);
    // c3 lands: the line moved, and c2's head is due again.
    const t3 = w.engine.claim(w.c3.id, 'a3').token;
    w.engine.attachRepo(w.c3.id, t3, { name: 'g.claim.c3', remote: 'z' }, 'seed');
    w.push(w.c3.id, 'sha3', ['src/pricing.js']);
    w.land(w.c3.id, t3, 'm3');
    expect(w.engine.pairRechecks('main')).toEqual([{ claim: w.c2.id, sha: 'sha2', repo: 'g.claim.c2' }]);
    expect(w.engine.beginPair(w.c2.id, 'sha2', 'run-3')).toBe(true);
    expect(w.engine.pairRechecks('main')).toEqual([]); // running
    w.engine.recordPair(w.c2.id, 'sha2', { status: 'broken', lineHead: 'm3', broken: [w.article.id], partner: w.c3.id, log: 'x', startedAt: 0, finishedAt: 1 });
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'stale' });
    expect(w.engine.pairRechecks('main')).toEqual([]); // judged against m3
    // A head never checked on its own, or that failed its own checks, is not paired.
    const other = w.engine.addClaim({ statement: 'home', scope: ['src/home.js'], orderOverlaps: false });
    const tOther = w.engine.claim(other.id, 'a5').token;
    w.engine.attachRepo(other.id, tOther, { name: 'g.claim.c5', remote: 'q' }, 'm3');
    w.engine.recordPush(other.id, { sha: 'sha5', ref: 'refs/heads/main', before: null, paths: ['src/home.js'], isHead: true });
    expect(w.engine.pairRechecks('main')).toEqual([]);
  });

  it('the gate quotes the assertion itself, whether node:test prints it inline or as a block', () => {
    const w = shop();
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    w.engine.attachRepo(w.c2.id, t2, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    w.push(w.c2.id, 'sha2', ['src/pages.js']);
    w.engine.recordPair(w.c2.id, 'sha2', {
      status: 'broken', lineHead: 'm3', broken: [w.article.id], startedAt: 0, finishedAt: 1,
      log: 'BROKEN a1\n--- a1\nnot ok 1 - what you see is what you pay\n  ---\n  duration_ms: 12\n  failureType: \'testCodeFailure\'\n  error: |-\n    purchase 2 of lamp charged $42.00, but its page showed $40.00 just before it\n  code: \'ERR_ASSERTION\'',
    });
    const f = w.engine.findings().find((x) => x.finder === 'gate')!;
    expect(f.statement).toContain(`${w.c2.id} at sha2 meets the line at m3: purchase 2 of lamp charged $42.00, but its page showed $40.00 just before it`);
    expect(f.statement).not.toContain('|-');
  });

  it('a pair result for a commit the claim has moved past is recorded and stales nothing', () => {
    const w = shop();
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    w.engine.attachRepo(w.c2.id, t2, { name: 'g.claim.c2', remote: 'y' }, 'seed');
    w.push(w.c2.id, 'old', ['src/pages.js']);
    w.push(w.c2.id, 'new', ['src/pages.js']);
    w.engine.recordPair(w.c2.id, 'old', { status: 'broken', lineHead: 'm3', broken: [w.article.id], log: 'x', startedAt: 0, finishedAt: 1 });
    expect(w.engine.pushRecord(w.c2.id, 'old')?.pair?.status).toBe('broken');
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'claimed' });
    expect(w.engine.findings()).toHaveLength(0);
    expect(w.engine.events().find((e) => e.type === 'claim.pair_checked')?.data).toMatchObject({ current: false });
  });

  it('a located contradiction from an agent reaches only the claims it names, and the assumption holds elsewhere', () => {
    const w = shop();
    const t2 = w.engine.claim(w.c2.id, 'a2').token;
    const t3 = w.engine.claim(w.c3.id, 'a3').token;
    const other = w.engine.addClaim({ statement: 'the home page', scope: ['src/home.js'], orderOverlaps: false });
    const tOther = w.engine.claim(other.id, 'a5').token;
    const f = w.engine.fileFinding(w.c3.id, t3, {
      statement: 'a cached page shows a price the buyer no longer pays', effect: 'contradicts', targets: [w.article.id], where: [w.c2.id, w.c3.id],
    }).finding;
    expect(f.where).toEqual([w.c2.id, w.c3.id]);
    expect(w.engine.impactOf(f.id)).toMatchObject({ affected: [w.c2.id], landedAtRisk: [] }); // the finder is left out
    w.engine.verifyFinding(f.id);
    expect(w.engine.node(w.article.id)).toMatchObject({ status: 'holding' });
    expect(w.engine.node(w.c2.id)).toMatchObject({ status: 'stale' });
    expect(w.engine.node(other.id)).toMatchObject({ status: 'claimed' });
    expect(w.engine.renew(other.id, tOther).notices).toEqual([]);
    expect(w.engine.renew(w.c2.id, t2).notices.map((n) => n.type)).toEqual(['claim.stale']);
    // The same words without a where would be a different finding: a global one.
    expect(w.engine.fileFinding(w.c3.id, t3, { statement: f.statement, effect: 'contradicts', targets: [w.article.id] }).duplicate).toBe(false);
  });

  it('doubt does not travel along an edge that only orders overlapping scopes', () => {
    const { engine } = setup();
    const A = engine.addAssumption('the shared format is fixed');
    const first = engine.addClaim({ statement: 'first', scope: ['src/shared/**'], restsOn: [A.id] });
    const second = engine.addClaim({ statement: 'second', scope: ['src/shared/a.ts'] }); // overlaps: waits for first
    const finder = engine.addClaim({ statement: 'finder', scope: ['src/other/**'] });
    expect(engine.isReady(second.id)).toBe(false);
    engine.claim(first.id, 'a');
    const tf = engine.claim(finder.id, 'b').token;
    const f = engine.fileFinding(finder.id, tf, { statement: 'the format changed', effect: 'contradicts', targets: [A.id] }).finding;
    expect(engine.impactOf(f.id).affected).toEqual([first.id]);
    engine.verifyFinding(f.id);
    expect(engine.node(first.id)).toMatchObject({ status: 'stale' });
    expect(engine.node(second.id)).toMatchObject({ status: 'open' });
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

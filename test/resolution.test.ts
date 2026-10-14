import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { MemoryStore } from '../src/core/store';
import type { FindingEvidence } from '../src/core/types';

let now: number;
let engine: Engine;
let store: MemoryStore;
const repo = (name: string) => ({ name, remote: `https://git.invalid/${name}` });
const take = (line = 'main', restsOn: string[] = [], hedgeOn?: string) => {
  const c = engine.addClaim({ statement: 'Build useful work', scope: [`src/${line}-${engine.claims().length}.ts`], line, restsOn, hedgeOn });
  const lease = engine.claim(c.id, 'worker');
  return { c, token: lease.token };
};
beforeEach(() => {
  now = 100;
  store = new MemoryStore();
  engine = new Engine(store, { now: () => now }, { leaseMs: 10_000, hedgeMs: 1000 });
  engine.saveLine({ name: 'main', served: true, repo: repo('main'), head: 'base' });
});

describe('owner-reviewed product promises', () => {
  it('keeps proposals out of the constitution and out of other claims assumptions until adoption', () => {
    const { c, token } = take();
    const a = engine.proposeArticle(c.id, token, { statement: 'Buyers pay the displayed price' });
    expect(engine.constitution()).toEqual([]);
    expect(() => engine.addClaim({ statement: 'Rely on the proposal', scope: ['src/next.ts'], restsOn: [a.id] })).toThrow('not an accepted basis');
    engine.adoptArticle(a.id, { judged: true });
    expect(engine.constitution('main').map((a) => a.id)).toEqual([a.id]);
    expect(engine.addClaim({ statement: 'Rely on the accepted promise', scope: ['src/next.ts'], restsOn: [a.id] }).status).toBe('open');
  });

  it('requires the owner-controlled check file before executable adoption', () => {
    const { c, token } = take();
    const a = engine.proposeArticle(c.id, token, { statement: 'A quote stays valid', check: 'bun test constitution/quote.test.ts', checkFile: 'constitution/quote.test.ts' });
    expect(() => engine.adoptArticle(a.id, {})).toThrow('owner-controlled');
    expect(engine.constitution()).toEqual([]);
    engine.adoptArticle(a.id, { atSha: 'owner-commit' });
    expect(engine.constitution('main')[0]?.proposal?.atSha).toBe('owner-commit');
  });

  it('does not let a failed proposal stop work before it is adopted', () => {
    const { c, token } = take();
    const a = engine.proposeArticle(c.id, token, { statement: 'A product promise' });
    const { finding } = engine.fileFinding(c.id, token, { statement: 'This proposed promise fails', effect: 'contradicts', targets: [a.id], where: [c.id] });
    expect(() => engine.verifyFinding(finding.id)).toThrow('advice');
    expect(engine.getClaim(c.id).status).toBe('claimed');
  });

  it('records an amendment while preserving the original promise on other lines', () => {
    const previous = engine.addAssumption('Prices never change', { constitution: true });
    const { c, token } = take();
    const proposal = engine.proposeArticle(c.id, token, { statement: 'Prices change after purchase', replaces: previous.id });
    expect(engine.constitution('main').map((a) => a.id)).toEqual([previous.id]);
    engine.adoptArticle(proposal.id, { judged: true });
    expect(engine.constitution('main').map((a) => a.id)).toEqual([proposal.id]);
    expect(engine.constitution('independent').map((a) => a.id)).toEqual([previous.id]);
    expect(store.edgesFrom(proposal.id, 'supersedes')[0]?.target).toBe(previous.id);
  });

  it('forks the accepted constitution without importing later amendments from its source', () => {
    const original = engine.addAssumption('The first promise', { constitution: true });
    engine.addLine({ name: 'before', from: 'main', repo: repo('before') });
    const worker = take();
    const replacement = engine.proposeArticle(worker.c.id, worker.token, { statement: 'The amended promise', replaces: original.id });
    engine.adoptArticle(replacement.id, { judged: true });
    engine.addLine({ name: 'after', from: 'main', repo: repo('after') });
    expect(engine.constitution('before').map((a) => a.id)).toEqual([original.id]);
    expect(engine.constitution('after').map((a) => a.id)).toEqual([replacement.id]);
    const newer = engine.proposeArticle(worker.c.id, worker.token, { statement: 'Another amendment', replaces: replacement.id });
    engine.adoptArticle(newer.id, { judged: true });
    expect(engine.constitution('after').map((a) => a.id)).toEqual([replacement.id]);
  });

  it('does not retire a constitutional check by verifying an unlocated report', () => {
    const article = engine.addAssumption('A product promise', { constitution: true, check: 'true' });
    const worker = take();
    const { finding } = engine.fileFinding(worker.c.id, worker.token, { statement: 'It fails somewhere', effect: 'contradicts', targets: [article.id] });
    expect(() => engine.verifyFinding(finding.id)).toThrow('where');
    expect(engine.constitution('main').map((a) => a.id)).toEqual([article.id]);
  });
});

describe('deliberate sharing between independent groups', () => {
  function groups() {
    engine.labelLine('main', { sharing: 'isolated', group: 'a' });
    engine.addLine({ name: 'b', from: 'main', repo: repo('b'), head: 'base', sharing: 'isolated', group: 'b' });
    const a = engine.addAssumption('This approach is viable');
    const finder = take();
    const same = take('main', [a.id]);
    const other = take('b', [a.id]);
    const { finding } = engine.fileFinding(finder.c.id, finder.token, { statement: 'This approach fails', effect: 'contradicts', targets: [a.id] });
    return { a, finder, same, other, finding };
  }

  it('keeps even verified findings from changing another independent group until publication', () => {
    const { same, other, finding } = groups();
    engine.verifyFinding(finding.id);
    expect(engine.getClaim(same.c.id).status).toBe('stale');
    expect(engine.getClaim(other.c.id).status).toBe('claimed');
    expect(engine.renew(other.c.id, other.token).notices).toEqual([]);
    engine.publishFinding(finding.id, ['b']);
    expect(engine.getClaim(other.c.id).status).toBe('stale');
    expect(engine.contextFor(other.c.id, other.token).nodes.find((n) => n.kind === 'assumption')?.status).toBe('contradicted');
    expect(engine.renew(other.c.id, other.token).notices.some((n) => n.type === 'claim.stale')).toBe(true);
  });

  it('publishes a candidate with its uncertainty intact and never uses publication as evidence', () => {
    const { other, finding } = groups();
    engine.publishFinding(finding.id, ['b']);
    expect(engine.node(finding.id)?.status).toBe('unverified');
    expect(engine.getClaim(other.c.id).status).toBe('claimed');
    expect(engine.renew(other.c.id, other.token).notices.some((n) => n.type === 'finding.shared')).toBe(true);
  });

  it('filters other groups out of agent context even when the owner sees the whole graph', () => {
    const { finder, other, finding } = groups();
    const context = engine.contextFor(other.c.id, other.token);
    expect(context.nodes.some((n) => n.id === finder.c.id || n.id === finding.id)).toBe(false);
    expect(context.lines.map((l) => l.name)).toEqual(['b']);
    expect(engine.publicContext().nodes.some((n) => n.kind === 'claim' || n.kind === 'finding')).toBe(false);
    engine.publishFinding(finding.id, ['b']);
    expect(engine.contextFor(other.c.id, other.token).nodes.some((n) => n.id === finding.id)).toBe(true);
  });
});

describe('bounded hedges', () => {
  it('parks only explicit speculative work at the deadline and never verifies by timeout', () => {
    const a = engine.addAssumption('An uncertain premise');
    const finder = take();
    const { finding } = engine.fileFinding(finder.c.id, finder.token, { statement: 'Maybe the premise fails', effect: 'contradicts', targets: [a.id] });
    const speculative = take('main', [], finding.id);
    const ordinary = take();
    now += 1001;
    engine.expireHedges();
    expect(engine.node(finding.id)?.status).toBe('unverified');
    expect(engine.renew(speculative.c.id, speculative.token)).toMatchObject({ ok: false, reason: 'hedge-expired' });
    expect(engine.push(speculative.c.id, speculative.token, { sha: 'speculative', changedPaths: speculative.c.scope })).toMatchObject({ accepted: false, reason: 'hedge-expired' });
    expect(engine.renew(ordinary.c.id, ordinary.token).ok).toBe(true);
    const decision = engine.nodesForDisplay().find((n) => n.kind === 'decision');
    expect(decision).toMatchObject({ status: 'review', defaultAction: 'park-investigation' });
    expect(engine.publicContext().nodes.some((n) => n.kind === 'finding' || n.kind === 'decision')).toBe(false);
    engine.decide(decision!.id, 'continue-investigation', 'One more bounded attempt');
    expect(engine.renew(speculative.c.id, speculative.token).ok).toBe(true);
    expect(engine.node(finding.id)?.status).toBe('unverified');
  });

  it('parks and permits replanning only work explicitly resting on a refuted suspicion', () => {
    const a = engine.addAssumption('An uncertain premise');
    const reporter = take();
    const { finding } = engine.fileFinding(reporter.c.id, reporter.token, { statement: 'Maybe the premise fails', effect: 'contradicts', targets: [a.id] });
    const speculative = take('main', [], finding.id);
    engine.refuteFinding(finding.id);
    expect(engine.getClaim(reporter.c.id).status).toBe('claimed');
    expect(engine.getClaim(speculative.c.id).status).toBe('stale');
    now += 10_001;
    const replacement = engine.claim(speculative.c.id, 'replacement');
    expect(replacement.status).toBe('stale');
    expect(engine.replan(speculative.c.id, replacement.token, { restsOn: [], statement: 'Work on a supported premise' }).hedgeOn).toBeUndefined();
  });

  it('requires replanning a withdrawn own premise before accepting done and preserves its earlier statement', () => {
    const a = engine.addAssumption('My premise is true');
    const worker = take('main', [a.id]);
    const { finding } = engine.fileFinding(worker.c.id, worker.token, { statement: 'My premise is false', effect: 'contradicts', targets: [a.id] });
    engine.verifyFinding(finding.id);
    expect(() => engine.finish(worker.c.id, worker.token)).toThrow('withdrawn');
    engine.replan(worker.c.id, worker.token, { restsOn: [], statement: 'A revised promise' });
    const previous = store.edgesFrom(worker.c.id, 'supersedes')[0]!.target;
    expect(engine.node(previous)).toMatchObject({ status: 'superseded', statement: worker.c.statement });
    expect(store.edgesTo(previous, 'required for').map((e) => e.source)).toContain(a.id);
  });
});

describe('mechanical findings belong to recorded inputs', () => {
  function context() {
    const a = engine.addAssumption('Buyers pay the quote', { constitution: true, check: 'bun test constitution/quote.test.ts' });
    const worker = take();
    engine.attachRepo(worker.c.id, worker.token, repo('work'), 'base');
    engine.push(worker.c.id, worker.token, { sha: 'v1', changedPaths: worker.c.scope });
    const { finding } = engine.fileFinding(worker.c.id, worker.token, { statement: 'The quoted price changes', effect: 'contradicts', targets: [a.id], where: [worker.c.id] });
    const check = engine.beginFindingCheck(finding.id, 'base');
    return { worker, finding, check };
  }

  it('verifies a reproduced failure and returns the evidence to its holder', () => {
    const { worker, finding, check } = context();
    const evidence: FindingEvidence = { ...check.evidence, status: 'confirmed', log: 'Displayed 40, charged 42' };
    engine.recordFindingCheck(finding.id, evidence);
    expect(engine.node(finding.id)?.status).toBe('verified');
    expect(engine.getClaim(worker.c.id).status).toBe('stale');
  });

  it('does not invalidate useful work when a suspicion is refuted by the article check', () => {
    const { worker, finding, check } = context();
    engine.recordFindingCheck(finding.id, { ...check.evidence, status: 'refuted' });
    expect(engine.node(finding.id)?.status).toBe('refuted');
    expect(engine.getClaim(worker.c.id).status).toBe('claimed');
  });

  it('rejects an old result after the code moves', () => {
    const { worker, finding, check } = context();
    engine.push(worker.c.id, worker.token, { sha: 'v2', changedPaths: worker.c.scope });
    engine.recordFindingCheck(finding.id, { ...check.evidence, status: 'confirmed' });
    expect(engine.node(finding.id)?.status).toBe('unverified');
    expect(engine.getClaim(worker.c.id).status).toBe('claimed');
  });

  it('does not let a delayed result overwrite a newer check', () => {
    const { worker, finding, check } = context();
    now += 45 * 60_000 + 1;
    const newer = engine.beginFindingCheck(finding.id, 'base');
    engine.recordFindingCheck(finding.id, { ...check.evidence, status: 'confirmed' });
    expect(engine.node(finding.id)).toMatchObject({ status: 'unverified', evidence: newer.evidence });
    expect(engine.getClaim(worker.c.id).status).toBe('claimed');
  });
});

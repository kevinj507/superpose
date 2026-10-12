import { describe, expect, it } from 'vitest';
import { Coordinator, type Tx } from '../src/core/coordinator';
import { Engine, EngineError } from '../src/core/engine';
import { FakeRepoHost, MapKeyValue } from '../src/core/fake-host';
import { changedPaths, claimRepoName, lineRepoName, parseRepoName } from '../src/core/repos';
import { MemoryStore } from '../src/core/store';

const LEASE = 120_000;

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, { leaseMs: LEASE, hedgeMs: 300_000, newToken: () => `lease${++n}` });
  const host = new FakeRepoHost(new MapKeyValue(), clock);
  // MemoryStore has no rollback; the engine validates before writing, which
  // is all these tests rely on.
  const tx: Tx = (fn) => fn(engine);
  const coord = new Coordinator(tx, host, { graph: 'demo', now: () => clock.now() });
  return { engine, host, coord, clock };
}

// A line seeded with a small project, and one claim on it.
async function seeded() {
  const w = setup();
  const line = await w.coord.ensureLine('main');
  w.host.commit(line.name, { 'package.json': '{}', 'src/app.ts': 'export {}', 'src/rate/limit.ts': '// todo' }, 'seed');
  const claim = w.engine.addClaim({ statement: 'rate limiting', scope: ['src/rate/**'] });
  return { ...w, line, claim };
}

describe('a claim gets its own repo and a token that lives with its lease', () => {
  it('claiming forks the line into the claim\'s repo, based at the line\'s tip', async () => {
    const w = await seeded();
    const grant = await w.coord.claim(w.claim.id, 'agent-1');
    expect(grant.repo.name).toBe('demo.claim.c1');
    expect(grant.baseSha).toBe(w.host.head('demo.line.main'));
    expect(w.host.head('demo.claim.c1')).toBe(grant.baseSha);
    expect(w.host.files(grant.baseSha!).get('src/rate/limit.ts')).toBe('// todo');
    expect(w.engine.getClaim(w.claim.id)).toMatchObject({ repo: grant.repo, baseSha: grant.baseSha });
  });

  it('the token can push to the claim\'s repo only, and only until the lease would end', async () => {
    const w = await seeded();
    const grant = await w.coord.claim(w.claim.id, 'agent-1');
    expect(grant.git!.expiresAt).toBe(w.clock.t + LEASE - 1000);
    expect(w.host.canPush('demo.claim.c1', grant.git!.token)).toBe(true);
    expect(w.host.canPush('demo.line.main', grant.git!.token)).toBe(false);
    w.clock.t += LEASE - 1000;
    expect(w.host.canPush('demo.claim.c1', grant.git!.token)).toBe(false);
  });

  it('renewing the lease renews the token and retires the old one', async () => {
    const w = await seeded();
    const grant = await w.coord.claim(w.claim.id, 'agent-1');
    w.clock.t += LEASE / 2;
    const renewed = await w.coord.renew(w.claim.id, grant.token);
    expect(renewed.ok).toBe(true);
    expect(renewed.git!.expiresAt).toBe(renewed.expiresAt! - 1000);
    expect(w.host.canPush('demo.claim.c1', renewed.git!.token)).toBe(true);
    expect(w.host.canPush('demo.claim.c1', grant.git!.token)).toBe(false);
  });

  it('a stale claim\'s token is not renewed and lapses with the lease', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('counters can live in KV');
    const onA = w.engine.addClaim({ statement: 'count requests', scope: ['src/count/**'], restsOn: [A.id] });
    const finder = await w.coord.claim(w.claim.id, 'finder');
    const grant = await w.coord.claim(onA.id, 'agent-2');
    const { finding } = w.engine.fileFinding(w.claim.id, finder.token, {
      statement: 'KV is eventually consistent', effect: 'contradicts', targets: [A.id],
    });
    w.engine.verifyFinding(finding.id);
    w.clock.t += LEASE / 2;
    const renewed = await w.coord.renew(onA.id, grant.token);
    expect(renewed).toMatchObject({ ok: false, reason: 'stale' });
    expect(renewed.git).toBeUndefined();
    expect(w.host.canPush(grant.repo.name, grant.git!.token)).toBe(true);
    w.clock.t += LEASE / 2;
    expect(w.host.canPush(grant.repo.name, grant.git!.token)).toBe(false);
  });

  it('finishing revokes the token at once', async () => {
    const w = await seeded();
    const grant = await w.coord.claim(w.claim.id, 'agent-1');
    await w.coord.finish(w.claim.id, grant.token);
    expect(w.host.canPush('demo.claim.c1', grant.git!.token)).toBe(false);
    expect(w.engine.getClaim(w.claim.id).status).toBe('done');
  });

  it('a released claim goes back to the ready set and its next agent continues in the same repo', async () => {
    const w = await seeded();
    const first = await w.coord.claim(w.claim.id, 'agent-1');
    const work = w.host.commit(first.repo.name, { 'src/rate/limit.ts': '// half done' }, 'wip').after;
    await w.coord.release(w.claim.id, first.token);
    expect(w.host.canPush(first.repo.name, first.git!.token)).toBe(false);
    expect(w.engine.ready().map((c) => c.id)).toContain(w.claim.id);
    const second = await w.coord.claim(w.claim.id, 'agent-2');
    expect(second.repo).toEqual(first.repo);
    expect(w.host.head(second.repo.name)).toBe(work);
    expect(w.host.calls.filter((c) => c.startsWith('fork'))).toHaveLength(1);
  });

  it('taking over a lapsed lease retires the old holder\'s token', async () => {
    const w = await seeded();
    const first = await w.coord.claim(w.claim.id, 'agent-1');
    w.clock.t += LEASE + 1;
    const second = await w.coord.claim(w.claim.id, 'agent-2');
    expect(second.repo).toEqual(first.repo);
    expect(w.host.calls).toContain(`revokeToken ${first.repo.name} ${w.host.tokens(first.repo.name)[0]!.id}`);
    expect(w.host.canPush(first.repo.name, second.git!.token)).toBe(true);
  });

  it('if the repo cannot be made, the claim is handed back and can be taken again', async () => {
    const w = await seeded();
    w.host.failNext.fork = 'UPSTREAM_UNAVAILABLE';
    await expect(w.coord.claim(w.claim.id, 'agent-1')).rejects.toMatchObject({ code: 'repo_unavailable' });
    expect(w.engine.getClaim(w.claim.id)).toMatchObject({ status: 'open' });
    expect(w.engine.getClaim(w.claim.id).lease).toBeUndefined();
    const grant = await w.coord.claim(w.claim.id, 'agent-2');
    expect(grant.git).toBeDefined();
  });

  it('if no token can be minted, the claim is handed back but keeps its repo', async () => {
    const w = await seeded();
    w.host.failNext.mintToken = 'INTERNAL_ERROR';
    await expect(w.coord.claim(w.claim.id, 'agent-1')).rejects.toBeInstanceOf(EngineError);
    expect(w.engine.getClaim(w.claim.id)).toMatchObject({ status: 'open', repo: { name: 'demo.claim.c1' } });
  });

  it('a stale claim whose agent is gone can be taken, but gets write access only once re-planned', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('counters can live in KV');
    const B = w.engine.addAssumption('counters live in a Durable Object');
    const onA = w.engine.addClaim({ statement: 'count requests', scope: ['src/count/**'], restsOn: [A.id] });
    const finder = await w.coord.claim(w.claim.id, 'finder');
    await w.coord.claim(onA.id, 'agent-2');
    const { finding } = w.engine.fileFinding(w.claim.id, finder.token, {
      statement: 'KV is eventually consistent', effect: 'contradicts', targets: [A.id],
    });
    w.engine.verifyFinding(finding.id);
    w.clock.t += LEASE + 1; // agent-2 is gone
    const taken = await w.coord.claim(onA.id, 'agent-3');
    expect(taken.status).toBe('stale');
    expect(taken.git).toBeUndefined();
    const replanned = await w.coord.replan(onA.id, taken.token, { restsOn: [B.id] });
    expect(replanned.claim.status).toBe('claimed');
    expect(w.host.canPush(taken.repo.name, replanned.git!.token)).toBe(true);
  });

  it('a seeding token for a line comes from the admin route, not from claiming', async () => {
    const w = setup();
    const access = await w.coord.lineAccess('main', 'write', 3600);
    expect(access.repo).toBe('demo.line.main');
    expect(w.host.canPush('demo.line.main', access.token)).toBe(true);
  });
});

describe('the paths a push changed, from its trees', () => {
  it('lists added, modified and deleted files, descending only where trees differ', async () => {
    const w = await seeded();
    const repo = 'demo.line.main';
    const before = w.host.head(repo)!;
    w.host.commit(repo, { 'docs/a.md': 'a', 'docs/b.md': 'b', 'deep/x/y/z.txt': 'z' });
    const mid = w.host.head(repo)!;
    const { after } = w.host.commit(repo, { 'src/rate/limit.ts': 'done', 'src/app.ts': null, 'src/rate/new.ts': 'n' });
    let reads = 0;
    const counting = Object.create(w.host, {
      readTree: { value: (r: string, t: string) => (reads++, w.host.readTree(r, t)) },
    });
    expect(await changedPaths(counting, repo, mid, after)).toEqual(['src/app.ts', 'src/rate/limit.ts', 'src/rate/new.ts']);
    // root, src and src/rate on each side; docs/ and deep/ are never opened.
    expect(reads).toBe(6);
    expect(await changedPaths(w.host, repo, before, mid)).toEqual(['deep/x/y/z.txt', 'docs/a.md', 'docs/b.md']);
  });

  it('treats a push with no previous commit as adding every file', async () => {
    const w = await seeded();
    const head = w.host.head('demo.line.main')!;
    expect(await changedPaths(w.host, 'demo.line.main', '0'.repeat(40), head)).toEqual([
      'package.json', 'src/app.ts', 'src/rate/limit.ts',
    ]);
  });

  it('sees a file replaced by a directory of the same name', async () => {
    const w = await seeded();
    const repo = 'demo.line.main';
    const { before, after } = w.host.commit(repo, { 'package.json': null, 'package.json/inner.txt': 'odd but legal' });
    expect(await changedPaths(w.host, repo, before, after)).toEqual(['package.json', 'package.json/inner.txt']);
  });
});

describe('repo names route a push back to its graph', () => {
  it('round-trips line and claim names', () => {
    expect(parseRepoName(claimRepoName('demo', 'c12'))).toEqual({ graph: 'demo', kind: 'claim', id: 'c12' });
    expect(parseRepoName(lineRepoName('demo-2', 'main'))).toEqual({ graph: 'demo-2', kind: 'line', id: 'main' });
    expect(parseRepoName('spike-repo')).toBeNull();
  });
});

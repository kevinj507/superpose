import { describe, expect, it } from 'vitest';
import { Coordinator, type Tx } from '../src/core/coordinator';
import { Engine } from '../src/core/engine';
import { FakeRepoHost, MapKeyValue } from '../src/core/fake-host';
import { MemoryStore } from '../src/core/store';

// Fixes for what the state-machine review found (2026-10-12), one test each.

const LEASE = 120_000;
const MAIN = 'refs/heads/main';

function setup() {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const engine = new Engine(new MemoryStore(), clock, {
    leaseMs: LEASE, hedgeMs: 300_000, newToken: () => `lease${++n}`, dependencyGate: 'landed',
  });
  const host = new FakeRepoHost(new MapKeyValue(), clock);
  const tx: Tx = (fn) => fn(engine);
  const coord = new Coordinator(tx, host, { graph: 'g', now: () => clock.now() });
  return { engine, host, coord, clock };
}

async function seeded() {
  const w = setup();
  const line = await w.coord.ensureLine('main');
  w.host.commit(line.name, { 'src/shared.ts': 'v1', 'src/a/x.ts': 'x', 'src/b/y.ts': 'y' }, 'seed');
  return w;
}

// Claim, commit, report, finish; with the 'skipped' check local mode records.
async function finished(w: Awaited<ReturnType<typeof seeded>>, id: string, files: Record<string, string>) {
  const g = await w.coord.claim(id, `agent-${id}`);
  const sha = w.host.commit(g.repo.name, files, `w\n\nSuperpose-Claim: ${id}`).after;
  await w.coord.notePush(id, g.token, sha);
  w.engine.recordCheck(id, sha, { status: 'passed', exitCode: 0, startedAt: 0, finishedAt: 0 });
  await w.coord.finish(id, g.token);
  return { g, sha };
}

function finding(w: ReturnType<typeof setup>, finder: string, token: string, target: string) {
  return w.engine.fileFinding(finder, token, { statement: `${target} is false`, effect: 'contradicts', targets: [target] }).finding;
}

describe('landing while things change', () => {
  it('a claim made stale while landing still records its merge, unlocks the line, and is reported at risk', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'], restsOn: [A.id] });
    const watcher = w.engine.addClaim({ statement: 'w', scope: ['notes/**'] });
    await finished(w, c.id, { 'src/a/x.ts': 'x2' });
    const landing = w.engine.beginNextLanding('main')!;
    const wl = await w.coord.claim(watcher.id, 'watcher');
    w.engine.verifyFinding(finding(w, watcher.id, wl.token, A.id).id);
    expect(w.engine.getClaim(c.id).status).toBe('stale');
    expect(w.engine.completeLanding('main', c.id, { status: 'landed', merge: 'm1' }, landing.landing)).toBe(true);
    expect(w.engine.line('main')).toMatchObject({ head: 'm1', landing: undefined });
    expect(w.engine.getClaim(c.id)).toMatchObject({ status: 'landed', landedSha: 'm1' });
    expect(w.engine.events().some((e) => e.type === 'reality.at_risk' && e.claims.includes(c.id))).toBe(true);
  });

  it('a stale claim whose landing had failed lands afresh after re-planning and finishing', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const B = w.engine.addAssumption('b');
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'], restsOn: [A.id] });
    const watcher = w.engine.addClaim({ statement: 'w', scope: ['notes/**'] });
    await finished(w, c.id, { 'src/a/x.ts': 'x2' });
    const l = w.engine.beginNextLanding('main')!;
    w.engine.completeLanding('main', c.id, { status: 'conflict', files: ['src/a/x.ts'] }, l.landing);
    const wl = await w.coord.claim(watcher.id, 'watcher');
    w.engine.verifyFinding(finding(w, watcher.id, wl.token, A.id).id);
    const again = await w.coord.claim(c.id, 'second');
    await w.coord.replan(c.id, again.token, { restsOn: [B.id] });
    await w.coord.finish(c.id, again.token);
    expect(w.engine.landable(c.id)).toBe(true);
  });
});

describe('claims that rest on something already contradicted', () => {
  it('handed back, such a claim is stale, so the next agent can take it and must re-plan', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const finder = w.engine.addClaim({ statement: 'f', scope: ['src/a/**'], restsOn: [A.id] });
    const g = await w.coord.claim(finder.id, 'finder');
    w.engine.verifyFinding(finding(w, finder.id, g.token, A.id).id);
    expect(w.engine.getClaim(finder.id).status).toBe('claimed'); // the finder itself is not stopped
    await w.coord.release(finder.id, g.token);
    expect(w.engine.getClaim(finder.id).status).toBe('stale');
    expect(w.engine.ready().map((c) => c.id)).toContain(finder.id);
    expect((await w.coord.claim(finder.id, 'next')).status).toBe('stale');
  });

  it('new claims cannot rest on a contradicted assumption, and declaring it in other words is refused too', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('KV reads are strongly consistent');
    const x = w.engine.addClaim({ statement: 'x', scope: ['x/**'], restsOn: [A.id] });
    const g = await w.coord.claim(x.id, 'x');
    w.engine.verifyFinding(finding(w, x.id, g.token, A.id).id);
    expect(() => w.engine.addClaim({ statement: 'y', scope: ['y/**'], restsOn: [A.id] })).toThrow(/contradicted/);
    expect(() => w.engine.declareAssumption(x.id, g.token, { statement: 'kv reads are strongly consistent.' })).toThrow(/contradicted/);
  });

  it("refuting a finding parks its finder's work even if the finder handed its claim back", async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const finder = w.engine.addClaim({ statement: 'f', scope: ['src/a/**'] });
    const g = await w.coord.claim(finder.id, 'finder');
    const f = finding(w, finder.id, g.token, A.id);
    const sha = w.host.commit(g.repo.name, { 'src/a/x.ts': 'built on the finding' }).after;
    await w.coord.notePush(finder.id, g.token, sha);
    await w.coord.release(finder.id, g.token);
    w.engine.refuteFinding(f.id);
    expect(w.engine.getClaim(finder.id)).toMatchObject({ status: 'stale', kept: [expect.objectContaining({ sha })] });
  });
});

describe('dependencies', () => {
  it('a stale claim waiting on work that has not landed is not offered', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const dep = w.engine.addClaim({ statement: 'dep', scope: ['src/b/**'] });
    const waiting = w.engine.addClaim({ statement: 'w', scope: ['src/a/**'], restsOn: [A.id], requires: [dep.id] });
    const g = await w.coord.claim(dep.id, 'dep');
    w.engine.verifyFinding(finding(w, dep.id, g.token, A.id).id);
    expect(w.engine.getClaim(waiting.id).status).toBe('stale');
    expect(w.engine.ready().map((c) => c.id)).not.toContain(waiting.id);
  });

  it('work on one line cannot build on a claim of another line it does not carry', async () => {
    const w = await seeded();
    const x = w.engine.addClaim({ statement: 'x', scope: ['**'] });
    const head = w.host.head('g.line.main');
    w.engine.addLine({ name: 'other', from: 'main', repo: { name: 'g.line.other', remote: 'r' }, head });
    expect(() => w.engine.addClaim({ statement: 'y', scope: ['**'], line: 'other', requires: [x.id] })).toThrow(/cannot build on it/);
  });
});

describe('tokens', () => {
  it('every token a lease held is revoked when it ends, including ones replaced at renewals', async () => {
    const w = await seeded();
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'] });
    const g = await w.coord.claim(c.id, 'a');
    w.clock.t += 10_000;
    const r1 = await w.coord.renew(c.id, g.token);
    w.clock.t += 10_000;
    await w.coord.renew(c.id, g.token);
    await w.coord.release(c.id, g.token);
    expect(w.host.canPush(g.repo.name, g.git!.token)).toBe(false);
    expect(w.host.canPush(g.repo.name, r1.git!.token)).toBe(false);
    expect(w.host.tokens(g.repo.name).every((t) => t.revoked)).toBe(true);
  });
});

describe('what finishing hands in', () => {
  it('a repo reset to its base hands in nothing, and a repo reset to an older commit hands that in', async () => {
    const w = await seeded();
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'] });
    const g = await w.coord.claim(c.id, 'a');
    const first = w.host.commit(g.repo.name, { 'src/a/x.ts': '1' });
    await w.coord.notePush(c.id, g.token, first.after);
    const second = w.host.commit(g.repo.name, { 'src/a/x.ts': '2' });
    await w.coord.notePush(c.id, g.token, second.after);
    // The agent resets its repo to the first commit and finishes.
    w.host.setHead(g.repo.name, first.after);
    w.clock.t += 1;
    await w.coord.finish(c.id, g.token);
    expect(w.engine.getClaim(c.id).headSha).toBe(first.after);

    const d = w.engine.addClaim({ statement: 'd', scope: ['src/b/**'] });
    const h = await w.coord.claim(d.id, 'b');
    const work = w.host.commit(h.repo.name, { 'src/b/y.ts': 'discarded' });
    await w.coord.notePush(d.id, h.token, work.after);
    w.host.setHead(h.repo.name, work.before!);
    w.clock.t += 1;
    await w.coord.finish(d.id, h.token);
    expect(w.engine.getClaim(d.id).headSha).toBeUndefined();
  });
});

describe('scope after re-planning', () => {
  it('a once-refused commit accepted later is judged against the scope as re-planned', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const B = w.engine.addAssumption('b');
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/**'], restsOn: [A.id] });
    const watcher = w.engine.addClaim({ statement: 'w', scope: ['notes/**'] });
    const g = await w.coord.claim(c.id, 'a');
    const wl = await w.coord.claim(watcher.id, 'w');
    w.engine.verifyFinding(finding(w, watcher.id, wl.token, A.id).id);
    const sha = w.host.commit(g.repo.name, { 'src/a/x.ts': 'a', 'src/b/y.ts': 'b' }).after;
    expect(await w.coord.notePush(c.id, g.token, sha)).toMatchObject({ accepted: false, reason: 'stale' });
    await w.coord.replan(c.id, g.token, { restsOn: [B.id], scope: ['src/a/**'] });
    await w.coord.finish(c.id, g.token);
    expect(w.engine.pushRecord(c.id, sha)).toMatchObject({ accepted: true, verdict: 'scope-violation', outside: ['src/b/y.ts'] });
  });
});

describe('notices across holders', () => {
  it('the next holder of a claim hears what the previous one missed', async () => {
    const w = await seeded();
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'] });
    const g = await w.coord.claim(c.id, 'first');
    const sha = w.host.commit(g.repo.name, { 'src/a/x.ts': 'broken' }).after;
    await w.coord.notePush(c.id, g.token, sha);
    w.engine.recordCheck(c.id, sha, { status: 'failed', exitCode: 1, startedAt: 0, finishedAt: 0 });
    w.clock.t += LEASE + 1; // the first agent died before renewing
    const next = await w.coord.claim(c.id, 'second');
    const r = await w.coord.renew(c.id, next.token);
    expect(r.notices).toEqual([expect.objectContaining({ type: 'claim.checked', data: expect.objectContaining({ verdict: 'checks-failed' }) })]);
  });
});

describe('reopening after a conflict', () => {
  it('the next holder gets read access to the line, and only its own changes count after merging the line in', async () => {
    const w = await seeded();
    const a = w.engine.addClaim({ statement: 'a', scope: ['src/shared.ts'] });
    // Planned to run side by side on purpose, so the merge can conflict.
    const b = w.engine.addClaim({ statement: 'b', scope: ['src/shared.ts'], orderOverlaps: false });
    const ga = await w.coord.claim(a.id, 'a');
    const gb = await w.coord.claim(b.id, 'b');
    for (const [c, g, text] of [[a, ga, 'from a'], [b, gb, 'from b']] as const) {
      const sha = w.host.commit(g.repo.name, { 'src/shared.ts': text }).after;
      await w.coord.notePush(c.id, g.token, sha);
      w.engine.recordCheck(c.id, sha, { status: 'passed', exitCode: 0, startedAt: 0, finishedAt: 0 });
      await w.coord.finish(c.id, g.token);
    }
    // a lands; b conflicts.
    const la = w.engine.beginNextLanding('main')!;
    const merged = w.host.merge('g.line.main', la.sha, 'land a');
    w.engine.completeLanding('main', a.id, { status: 'landed', merge: (merged as { merge: string }).merge }, la.landing);
    const lb = w.engine.beginNextLanding('main')!;
    w.engine.completeLanding('main', b.id, { status: 'conflict', files: ['src/shared.ts'] }, lb.landing);
    w.engine.reopen(b.id);
    expect(w.engine.getClaim(b.id).baseSha).toBe(w.engine.line('main').head);

    const again = await w.coord.claim(b.id, 'b2');
    expect(again.line).toMatchObject({ remote: expect.any(String), head: w.engine.line('main').head });
    expect(w.host.canPush('g.line.main', again.line!.token)).toBe(false); // read only
    // The agent merges the line into its repo, resolves, and pushes.
    w.host.setHead(again.repo.name, w.engine.line('main').head!);
    const resolved = w.host.commit(again.repo.name, { 'src/shared.ts': 'from a and b' }, `resolve\n\nSuperpose-Claim: ${b.id}`).after;
    expect(await w.coord.notePush(b.id, again.token, resolved)).toMatchObject({ accepted: true, paths: ['src/shared.ts'], outside: [] });
  });
});

describe('second review fixes', () => {
  it('a claim landing right now cannot be taken over, and a landing report after the claim moved on leaves it alone', async () => {
    const w = await seeded();
    const A = w.engine.addAssumption('a');
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'], restsOn: [A.id] });
    const watcher = w.engine.addClaim({ statement: 'w', scope: ['notes/**'] });
    await finished(w, c.id, { 'src/a/x.ts': 'x2' });
    const landing = w.engine.beginNextLanding('main')!;
    const wl = await w.coord.claim(watcher.id, 'watcher');
    w.engine.verifyFinding(finding(w, watcher.id, wl.token, A.id).id);
    expect(w.engine.ready().map((x) => x.id)).not.toContain(c.id);
    await expect(w.coord.claim(c.id, 'thief')).rejects.toMatchObject({ code: 'not_ready' });
    // Once the landing reports, the claim is the work it started with: landed, at risk.
    w.engine.completeLanding('main', c.id, { status: 'landed', merge: 'm1' }, landing.landing);
    expect(w.engine.getClaim(c.id).status).toBe('landed');
  });

  it('a commit too large to list completely cannot land, and a re-judged one is listed again in full', async () => {
    const w = await seeded();
    const c = w.engine.addClaim({ statement: 'c', scope: ['src/a/**'] });
    const g = await w.coord.claim(c.id, 'a');
    const files: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) files[`src/a/f${String(i).padStart(4, '0')}.ts`] = String(i);
    files['zz/evil.ts'] = 'outside';
    const sha = w.host.commit(g.repo.name, files).after;
    const row = await w.coord.inspectPush(c.id, { sha, ref: 'refs/heads/side', before: null });
    expect(row).toMatchObject({ tooLarge: true, verdict: 'scope-violation', accepted: false });
    const again = await w.coord.inspectPush(c.id, { sha, ref: 'refs/heads/main', before: null });
    expect(again).toMatchObject({ accepted: true, verdict: 'scope-violation' });
  }, 30_000);

  it('a reopened claim is judged from the line head its holder was handed, or from its fork point until it has it', async () => {
    const w = await seeded();
    const a = w.engine.addClaim({ statement: 'a', scope: ['src/shared.ts'] });
    const b = w.engine.addClaim({ statement: 'b', scope: ['src/shared.ts'], orderOverlaps: false });
    const ga = await w.coord.claim(a.id, 'a');
    const gb = await w.coord.claim(b.id, 'b');
    for (const [c, g, text] of [[a, ga, 'from a'], [b, gb, 'from b']] as const) {
      const sha = w.host.commit(g.repo.name, { 'src/shared.ts': text }).after;
      await w.coord.notePush(c.id, g.token, sha);
      w.engine.recordCheck(c.id, sha, { status: 'passed', exitCode: 0, startedAt: 0, finishedAt: 0 });
      await w.coord.finish(c.id, g.token);
    }
    const la = w.engine.beginNextLanding('main')!;
    const merged = w.host.merge('g.line.main', la.sha, 'land a') as { merge: string };
    w.engine.completeLanding('main', a.id, { status: 'landed', merge: merged.merge }, la.landing);
    const lb = w.engine.beginNextLanding('main')!;
    w.engine.completeLanding('main', b.id, { status: 'conflict', files: ['src/shared.ts'] }, lb.landing);
    w.engine.reopen(b.id);
    // Something else lands meanwhile: the line moves on.
    const later = w.host.commit('g.line.main', { 'src/c.ts': 'c' }).after;
    const again = await w.coord.claim(b.id, 'b2');
    expect(again.line!.head).toBe(later);
    expect(w.engine.getClaim(b.id).baseSha).toBe(later);
    // Not merged in yet: judged from where the repo was forked, so only b's own file counts.
    const fix = w.host.commit(again.repo.name, { 'src/shared.ts': 'from b, again' }).after;
    expect(await w.coord.notePush(b.id, again.token, fix)).toMatchObject({ accepted: true, outside: [] });
    // The line token is revoked when the lease ends.
    await w.coord.release(b.id, again.token);
    expect(w.host.tokens('g.line.main').filter((t) => t.scope === 'read').every((t) => t.revoked)).toBe(true);
  });

  it('only the fetch step speaks for the platform: the project exiting 90 is a failure, not an error', async () => {
    const { checkRunFrom } = await import('../src/core/checks');
    const cfg = { check: 'npm test', timeoutSeconds: 60 };
    expect(checkRunFrom({ exitCode: 90, stdout: '', stderr: '', ms: 1, step: 0 }, cfg, 0, 1).status).toBe('error');
    expect(checkRunFrom({ exitCode: 90, stdout: '', stderr: '', ms: 1, step: 1 }, cfg, 0, 1).status).toBe('failed');
  });
});

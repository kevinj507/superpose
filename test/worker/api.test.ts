import { SELF, env, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FakeRepoHost } from '../../src/core/fake-host';
import type { Graph } from '../../src/graph';

const ADMIN = 'test-admin';
const AGENT = 'test-agent';
let graphSeq = 0;

async function api<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await SELF.fetch(`https://superpose.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

// A small project: A carries three claims directly and one through a claim it
// builds on; B carries the rest.
async function project() {
  const gid = `t${++graphSeq}`;
  const g = `/api/graphs/${gid}`;
  const A = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'the date library handles time zones' })).data;
  const B = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'requests are authenticated upstream' })).data;
  const onA = [];
  for (let i = 1; i <= 3; i++) {
    onA.push((await api('POST', `${g}/claims`, ADMIN, { statement: `uses dates ${i}`, scope: [`src/d${i}/**`], restsOn: [A.id] })).data);
  }
  const onB = [];
  for (let i = 1; i <= 5; i++) {
    onB.push((await api('POST', `${g}/claims`, ADMIN, { statement: `other ${i}`, scope: [`src/o${i}/**`], restsOn: [B.id] })).data);
  }
  const tokens: Record<string, string> = {};
  for (const c of [...onA, ...onB]) {
    tokens[c.id] = (await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: `agent-${c.id}` })).data.token;
  }
  const d1sha = await pushTo(gid, onA[0].id, tokens[onA[0].id]!, { 'src/d1/a.ts': 'a' });
  await api('POST', `${g}/claims/${onA[0].id}/finish`, tokens[onA[0].id]);
  const builtOn = (await api('POST', `${g}/claims`, ADMIN, { statement: 'builds on d1', scope: ['src/x/**'], requires: [onA[0].id] })).data;
  tokens[builtOn.id] = (await api('POST', `${g}/claims/${builtOn.id}/claim`, AGENT, { agent: 'agent-x' })).data.token;
  return { gid, g, A, B, onA, onB, builtOn, tokens, d1sha };
}

// Commit to a claim's repo in the in-memory git host, then report the push
// the way an agent does. Returns the commit.
async function pushTo(gid: string, claim: string, lease: string, files: Record<string, string | null>, report = true) {
  const sha = await host(gid, (h) => h.commit(`${gid}.claim.${claim}`, files, `work\n\nSuperpose-Claim: ${claim}`).after);
  if (report) await api('POST', `/api/graphs/${gid}/claims/${claim}/push`, lease, { sha });
  return sha;
}

describe('the API in front of the graph', () => {
  it('accepts owner-only checked external reports and rejects incomplete bindings', async () => {
    const g = `/api/graphs/t${++graphSeq}`;
    const premise = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'budget guard caused interruption' })).data;
    const claim = (await api('POST', `${g}/claims`, ADMIN, { statement: 'diagnosis', scope: ['src/diagnosis/**'], restsOn: [premise.id] })).data;
    const partner = (await api('POST', `${g}/claims`, ADMIN, { statement: 'recovery', scope: ['src/recovery/**'], restsOn: [premise.id] })).data;
    const independent = (await api('POST', `${g}/claims`, ADMIN, { statement: 'CSV export', scope: ['src/export/**'] })).data;
    for (const c of [partner, independent]) await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: c.id });
    const lease = (await api('POST', `${g}/claims/${claim.id}/claim`, AGENT, { agent: 'diagnosis' })).data.token;
    const filed = await api('POST', `${g}/findings`, lease, { finder: claim.id, statement: 'capacity policy caused interruption', effect: 'contradicts', targets: [premise.id] });
    const path = `${g}/findings/${filed.data.finding.id}/external-check`;
    const binding = { incident_id: 'job-17', workload_digest: 'workload-sha256', code_sha: 'code-sha', config_revision: 'cfg-9', trace_digest: 'trace-sha256', verifier_version: 'challenge-v1' };
    expect((await api('POST', path, AGENT, { status: 'confirmed', binding, reason: 'replay confirms capacity', probes: ['capacity isolated'] })).status).toBe(401);
    expect((await api('POST', path, ADMIN, { status: 'confirmed', binding: { ...binding, trace_digest: '' }, reason: 'checked', probes: [] })).status).toBe(400);
    expect((await api('POST', path, ADMIN, { status: 'inconclusive', binding, reason: 'ambiguous replay', probes: ['overlap'] })).status).toBe(200);
    const snap = await api('GET', `${g}/snapshot`, ADMIN);
    expect(snap.data.nodes.find((node: any) => node.id === filed.data.finding.id)).toMatchObject({ status: 'unverified', externalEvidence: { status: 'inconclusive', binding } });
    expect((await api('POST', path, ADMIN, { status: 'confirmed', binding, reason: 'replay confirms capacity', probes: ['capacity isolated'] })).status).toBe(200);
    const settled = await api('GET', `${g}/snapshot`, ADMIN);
    expect(settled.data.nodes.filter((node: any) => node.kind === 'claim' && node.status === 'stale').map((node: any) => node.id).sort()).toEqual([claim.id, partner.id].sort());
    expect(settled.data.nodes.find((node: any) => node.id === independent.id)).toMatchObject({ status: 'claimed' });
  });

  it('requires the admin token to change the plan, the agent key to claim, and nothing to read', async () => {
    const g = `/api/graphs/t${++graphSeq}`;
    expect((await api('POST', `${g}/assumptions`, undefined, { statement: 'x' })).status).toBe(401);
    expect((await api('POST', `${g}/assumptions`, AGENT, { statement: 'x' })).status).toBe(401);
    const c = (await api('POST', `${g}/claims`, ADMIN, { statement: 'c', scope: ['c/**'] })).data;
    expect((await api('POST', `${g}/claims/${c.id}/claim`, 'wrong', { agent: 'a' })).status).toBe(401);
    expect((await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: 'a' })).status).toBe(200);
    expect((await api('POST', `${g}/claims/${c.id}/renew`, 'not-the-lease')).status).toBe(401);
    expect((await api('GET', `${g}/snapshot`)).status).toBe(200);
  });

  it('runs the whole propagation flow: hedge, verify, notify the affected, block stale pushes, re-plan', async () => {
    const p = await project();
    const finder = p.onB[0].id;

    // Some work on a claim that will turn out to rest on a false assumption.
    const early = await pushTo(p.gid, p.onA[1].id, p.tokens[p.onA[1].id]!, { 'src/d2/a.ts': 'early' });

    const filed = await api('POST', `${p.g}/findings`, p.tokens[finder], {
      finder, statement: 'The date library drops time zones', effect: 'contradicts', targets: [p.A.id],
    });
    expect(filed.status).toBe(200);
    const fid = filed.data.finding.id;

    // Unverified: nobody stops.
    const quiet = await api('POST', `${p.g}/claims/${p.onA[1].id}/renew`, p.tokens[p.onA[1].id]);
    expect(quiet.data).toMatchObject({ ok: true, notices: [] });

    // d1 has landed (it finished, so the builds-on claim could start): it is
    // reported as served work at risk, not marked stale.
    const impact = await api('GET', `${p.g}/findings/${fid}/impact`, ADMIN);
    expect(impact.data.affected.sort()).toEqual([p.onA[1].id, p.onA[2].id, p.builtOn.id].sort());
    expect(impact.data.landedAtRisk).toEqual([p.onA[0].id]);
    expect(impact.data.cost).toBe(1);

    expect((await api('POST', `${p.g}/findings/${fid}/verify`, ADMIN)).status).toBe(200);

    for (const c of [p.onA[1], p.onA[2], p.builtOn]) {
      const r = await api('POST', `${p.g}/claims/${c.id}/renew`, p.tokens[c.id]);
      expect(r.data).toMatchObject({ ok: false, reason: 'stale' });
      expect(r.data.notices[0]).toMatchObject({ type: 'claim.stale', data: { finding: fid } });
    }
    for (const c of p.onB.slice(1)) {
      expect((await api('POST', `${p.g}/claims/${c.id}/renew`, p.tokens[c.id])).data).toMatchObject({ ok: true, notices: [] });
    }

    const s1 = await pushTo(p.gid, p.onA[1].id, p.tokens[p.onA[1].id]!, { 'src/d2/a.ts': 'a' }, false);
    const blocked = await api('POST', `${p.g}/claims/${p.onA[1].id}/push`, p.tokens[p.onA[1].id], { sha: s1 });
    expect(blocked.data).toMatchObject({ accepted: false, reason: 'stale' });

    const C = (await api('POST', `${p.g}/assumptions`, ADMIN, { statement: 'store UTC, convert at the edge' })).data;
    expect((await api('POST', `${p.g}/claims/${p.onA[1].id}/replan`, p.tokens[p.onA[1].id], { restsOn: [p.A.id] })).status).toBe(409);
    expect((await api('POST', `${p.g}/claims/${p.onA[1].id}/replan`, p.tokens[p.onA[1].id], { restsOn: [C.id] })).status).toBe(200);
    const s2 = await pushTo(p.gid, p.onA[1].id, p.tokens[p.onA[1].id]!, { 'src/d2/a.ts': 'b', 'package.json': '{}' }, false);
    const after = await api('POST', `${p.g}/claims/${p.onA[1].id}/push`, p.tokens[p.onA[1].id], { sha: s2 });
    expect(after.data).toEqual({
      accepted: true, verdict: 'scope-violation', paths: ['package.json', 'src/d2/a.ts'], outside: ['package.json'],
    });

    const snap = await api('GET', `${p.g}/snapshot`);
    const d2 = snap.data.nodes.find((n: any) => n.id === p.onA[1].id);
    expect(d2.kept).toEqual([expect.objectContaining({ sha: early })]);
    expect(snap.data.nodes.find((n: any) => n.id === p.onA[0].id)).toMatchObject({ status: 'landed' });
    expect(snap.data.events.some((e: any) => e.type === 'reality.at_risk' && e.claims.includes(p.onA[0].id))).toBe(true);
  });
});

describe('the Durable Object', () => {
  it('keeps the graph and live leases when it is evicted from memory', async () => {
    const p = await project();
    await evictAllDurableObjects();
    const r = await api('POST', `${p.g}/claims/${p.onB[2].id}/renew`, p.tokens[p.onB[2].id]);
    expect(r.data.ok).toBe(true);
    const snap = await api('GET', `${p.g}/snapshot`);
    expect(snap.data.nodes.filter((n: any) => n.kind === 'claim')).toHaveLength(9);
    expect(snap.data.edges.length).toBeGreaterThan(0);
  });

  it('never shows lease tokens to readers', async () => {
    const p = await project();
    const text = JSON.stringify((await api('GET', `${p.g}/snapshot`)).data);
    for (const token of Object.values(p.tokens)) expect(text).not.toContain(token);
  });

  it('keeps separate graphs separate', async () => {
    const one = await project();
    const two = await project();
    const f = await api('POST', `${one.g}/findings`, one.tokens[one.onB[0].id], {
      finder: one.onB[0].id, statement: 'tz', effect: 'contradicts', targets: [one.A.id],
    });
    await api('POST', `${one.g}/findings/${f.data.finding.id}/verify`, ADMIN);
    const snap = await api('GET', `${two.g}/snapshot`);
    expect(snap.data.nodes.filter((n: any) => n.status === 'stale')).toHaveLength(0);
  });

  it('gives a contested claim to exactly one of many agents racing for it', async () => {
    const g = `/api/graphs/t${++graphSeq}`;
    const c = (await api('POST', `${g}/claims`, ADMIN, { statement: 'contested', scope: ['c/**'] })).data;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: `racer-${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
  });

  it('leaves the graph unchanged when a call fails', async () => {
    const p = await project();
    const { now: _then, ...before } = (await api('GET', `${p.g}/snapshot`)).data;
    const bad = await api('POST', `${p.g}/findings`, p.tokens[p.onB[0].id], {
      finder: p.onB[0].id, statement: 'x', effect: 'contradicts', targets: ['a999'],
    });
    expect(bad.status).toBe(404);
    const { now: _now, ...after } = (await api('GET', `${p.g}/snapshot`)).data;
    expect(after).toEqual(before);
  });
});

// The in-memory git host inside a graph's Durable Object (REPO_HOST=fake).
function host<T>(gid: string, fn: (h: FakeRepoHost) => T): Promise<T> {
  const stub = env.GRAPH.get(env.GRAPH.idFromName(gid));
  return runInDurableObject(stub, (instance: Graph) => fn(instance.repoHost as FakeRepoHost));
}

describe('repos and git tokens over the API', () => {
  it('a claim comes with its own repo and a token that lasts as long as the lease', async () => {
    const gid = `t${++graphSeq}`;
    const g = `/api/graphs/${gid}`;
    const seed = await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
    expect(seed.status).toBe(200);
    expect(seed.data.repo).toBe(`${gid}.line.main`);
    const base = await host(gid, (h) => h.commit(`${gid}.line.main`, { 'src/a.ts': 'a' }, 'seed').after);
    expect((await api('POST', `${g}/lines/main/access`, AGENT, { scope: 'write' })).status).toBe(401);

    const c = (await api('POST', `${g}/claims`, ADMIN, { statement: 'c', scope: ['src/**'] })).data;
    const grant = (await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: 'a1' })).data;
    expect(grant).toMatchObject({ status: 'claimed', baseSha: base, repo: { name: `${gid}.claim.${c.id}` } });
    expect(grant.git.expiresAt).toBeLessThanOrEqual(grant.expiresAt);
    expect(grant.git.expiresAt).toBeGreaterThan(grant.expiresAt - 2000);
    expect(await host(gid, (h) => h.canPush(grant.repo.name, grant.git.token))).toBe(true);

    const renewed = (await api('POST', `${g}/claims/${c.id}/renew`, grant.token)).data;
    expect(renewed.ok).toBe(true);
    // The old token is left to lapse with the lease it was minted for.
    expect(await host(gid, (h) => [h.canPush(grant.repo.name, grant.git.token), h.canPush(grant.repo.name, renewed.git.token)]))
      .toEqual([true, true]);

    const snapshot = JSON.stringify((await api('GET', `${g}/snapshot`)).data);
    expect(snapshot).not.toContain(grant.git.token);
    expect(snapshot).not.toContain(renewed.git.token);

    expect((await api('POST', `${g}/claims/${c.id}/finish`, grant.token)).status).toBe(200);
    expect(await host(gid, (h) => h.canPush(grant.repo.name, renewed.git.token))).toBe(false);
  });

  it('a released claim can be taken by the next agent, in the same repo', async () => {
    const gid = `t${++graphSeq}`;
    const g = `/api/graphs/${gid}`;
    await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
    await host(gid, (h) => h.commit(`${gid}.line.main`, { 'src/a.ts': 'a' }));
    const c = (await api('POST', `${g}/claims`, ADMIN, { statement: 'c', scope: ['src/**'] })).data;
    const first = (await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: 'a1' })).data;
    expect((await api('POST', `${g}/claims/${c.id}/release`, first.token)).status).toBe(200);
    expect((await api('GET', `${g}/ready`)).data.map((r: any) => r.id)).toContain(c.id);
    const second = (await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: 'a2' })).data;
    expect(second.repo).toEqual(first.repo);
    expect(await host(gid, (h) => h.canPush(first.repo.name, first.git.token))).toBe(false);
  });
});

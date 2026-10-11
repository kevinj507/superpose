import { SELF, evictAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

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
  const g = `/api/graphs/t${++graphSeq}`;
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
  await api('POST', `${g}/claims/${onA[0].id}/push`, tokens[onA[0].id], { sha: 'd1-sha', changedPaths: ['src/d1/a.ts'] });
  await api('POST', `${g}/claims/${onA[0].id}/finish`, tokens[onA[0].id]);
  const builtOn = (await api('POST', `${g}/claims`, ADMIN, { statement: 'builds on d1', scope: ['src/x/**'], requires: [onA[0].id] })).data;
  tokens[builtOn.id] = (await api('POST', `${g}/claims/${builtOn.id}/claim`, AGENT, { agent: 'agent-x' })).data.token;
  return { g, A, B, onA, onB, builtOn, tokens };
}

describe('the API in front of the graph', () => {
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

    const filed = await api('POST', `${p.g}/findings`, p.tokens[finder], {
      finder, statement: 'The date library drops time zones', effect: 'contradicts', targets: [p.A.id],
    });
    expect(filed.status).toBe(200);
    const fid = filed.data.finding.id;

    // Unverified: nobody stops.
    const quiet = await api('POST', `${p.g}/claims/${p.onA[1].id}/renew`, p.tokens[p.onA[1].id]);
    expect(quiet.data).toMatchObject({ ok: true, notices: [] });

    const impact = await api('GET', `${p.g}/findings/${fid}/impact`);
    expect(impact.data.affected.sort()).toEqual([p.onA[0].id, p.onA[1].id, p.onA[2].id, p.builtOn.id].sort());
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

    const blocked = await api('POST', `${p.g}/claims/${p.onA[1].id}/push`, p.tokens[p.onA[1].id], { sha: 's', changedPaths: ['src/d2/a.ts'] });
    expect(blocked.data).toEqual({ accepted: false, reason: 'stale' });

    const C = (await api('POST', `${p.g}/assumptions`, ADMIN, { statement: 'store UTC, convert at the edge' })).data;
    expect((await api('POST', `${p.g}/claims/${p.onA[1].id}/replan`, p.tokens[p.onA[1].id], { restsOn: [p.A.id] })).status).toBe(409);
    expect((await api('POST', `${p.g}/claims/${p.onA[1].id}/replan`, p.tokens[p.onA[1].id], { restsOn: [C.id] })).status).toBe(200);
    const after = await api('POST', `${p.g}/claims/${p.onA[1].id}/push`, p.tokens[p.onA[1].id], { sha: 's2', changedPaths: ['src/d2/a.ts', 'package.json'] });
    expect(after.data).toEqual({ accepted: true, verdict: 'scope-violation', outside: ['package.json'] });

    const snap = await api('GET', `${p.g}/snapshot`);
    const d1 = snap.data.nodes.find((n: any) => n.id === p.onA[0].id);
    expect(d1).toMatchObject({ status: 'stale', kept: [{ sha: 'd1-sha' }] });
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
    const before = (await api('GET', `${p.g}/snapshot`)).data;
    const bad = await api('POST', `${p.g}/findings`, p.tokens[p.onB[0].id], {
      finder: p.onB[0].id, statement: 'x', effect: 'contradicts', targets: ['a999'],
    });
    expect(bad.status).toBe(404);
    expect((await api('GET', `${p.g}/snapshot`)).data).toEqual(before);
  });
});

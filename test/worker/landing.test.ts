import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FakeRepoHost } from '../../src/core/fake-host';
import type { Graph } from '../../src/graph';

const ADMIN = 'test-admin';
const AGENT = 'test-agent';
let seq = 0;

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

function inGraph<T>(gid: string, fn: (g: Graph, h: FakeRepoHost) => T | Promise<T>): Promise<T> {
  const stub = env.GRAPH.get(env.GRAPH.idFromName(gid));
  return runInDurableObject(stub, (instance: Graph) => fn(instance, instance.repoHost as FakeRepoHost));
}

async function graphWithLine() {
  const gid = `l${++seq}`;
  const g = `/api/graphs/${gid}`;
  await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
  await inGraph(gid, (_, h) => h.commit(`${gid}.line.main`, { 'README.md': 'demo', 'src/shared.ts': 'v1' }, 'seed'));
  return { gid, g };
}

async function claimAndWork(gid: string, id: string, files: Record<string, string>) {
  const g = `/api/graphs/${gid}`;
  const grant = (await api('POST', `${g}/claims/${id}/claim`, AGENT, { agent: `agent-${id}` })).data;
  const sha = await inGraph(gid, (_, h) => h.commit(grant.repo.name, files, `work\n\nSuperpose-Claim: ${id}`).after);
  const pushed = await api('POST', `${g}/claims/${id}/push`, grant.token, { sha });
  return { grant, sha, pushed: pushed.data };
}

const node = (snap: any, id: string) => snap.nodes.find((n: any) => n.id === id);

describe('landing', () => {
  it('lands in dependency order, so the claim built on another forks from code that contains it', async () => {
    const { gid, g } = await graphWithLine();
    const a = (await api('POST', `${g}/claims`, ADMIN, { statement: 'the store', scope: ['src/store/**'] })).data;
    const b = (await api('POST', `${g}/claims`, ADMIN, { statement: 'the API on the store', scope: ['src/api/**'], requires: [a.id] })).data;
    expect((await api('GET', `${g}/ready`)).data.map((c: any) => c.id)).toEqual([a.id]);

    const wa = await claimAndWork(gid, a.id, { 'src/store/db.ts': 'export const db = 1' });
    expect((await api('GET', `${g}/ready`)).data.map((c: any) => c.id)).toEqual([]);
    await api('POST', `${g}/claims/${a.id}/finish`, wa.grant.token);

    const snap = (await api('GET', `${g}/snapshot`)).data;
    expect(node(snap, a.id)).toMatchObject({ status: 'landed' });
    expect(snap.lines).toEqual([expect.objectContaining({ name: 'main', served: true, head: node(snap, a.id).landedSha })]);
    const message = await inGraph(gid, (_, h) => h.readCommit(`${gid}.line.main`, node(snap, a.id).landedSha));
    expect(message!.message).toContain(`Superpose-Claim: ${a.id}`);

    const wb = (await api('POST', `${g}/claims/${b.id}/claim`, AGENT, { agent: 'agent-b' })).data;
    const files = await inGraph(gid, (_, h) => h.files(h.head(wb.repo.name)!));
    expect(files.get('src/store/db.ts')).toBe('export const db = 1');
  });

  it('a claim whose head failed its checks does not land', async () => {
    const { gid, g } = await graphWithLine();
    const a = (await api('POST', `${g}/claims`, ADMIN, { statement: 'x', scope: ['src/x/**'] })).data;
    const w = await claimAndWork(gid, a.id, { 'src/x/a.ts': 'broken' });
    await inGraph(gid, (graph) => graph.recordCheck(gid, a.id, w.sha, { status: 'failed', exitCode: 1, startedAt: 1, finishedAt: 2 }));
    await api('POST', `${g}/claims/${a.id}/finish`, w.grant.token);
    expect(node((await api('GET', `${g}/snapshot`)).data, a.id)).toMatchObject({ status: 'done' });
  });

  it('checks that pass after the claim finished let it land then', async () => {
    const { gid, g } = await graphWithLine();
    const a = (await api('POST', `${g}/claims`, ADMIN, { statement: 'x', scope: ['src/x/**'] })).data;
    const w = await claimAndWork(gid, a.id, { 'src/x/a.ts': 'ok' });
    await inGraph(gid, (graph) => graph.recordCheck(gid, a.id, w.sha, { status: 'running', startedAt: 1 }));
    await api('POST', `${g}/claims/${a.id}/finish`, w.grant.token);
    expect(node((await api('GET', `${g}/snapshot`)).data, a.id).status).toBe('done');
    await inGraph(gid, (graph) => graph.recordCheck(gid, a.id, w.sha, { status: 'passed', exitCode: 0, startedAt: 1, finishedAt: 2 }));
    expect(node((await api('GET', `${g}/snapshot`)).data, a.id).status).toBe('landed');
  });

  it('a textual conflict is a review item on the claim, which can be reopened', async () => {
    const { gid, g } = await graphWithLine();
    const a = (await api('POST', `${g}/claims`, ADMIN, { statement: 'a', scope: ['src/**'] })).data;
    const b = (await api('POST', `${g}/claims`, ADMIN, { statement: 'b', scope: ['src/**'] })).data;
    const wa = await claimAndWork(gid, a.id, { 'src/shared.ts': 'from a' });
    const wb = await claimAndWork(gid, b.id, { 'src/shared.ts': 'from b' });
    await api('POST', `${g}/claims/${a.id}/finish`, wa.grant.token);
    await api('POST', `${g}/claims/${b.id}/finish`, wb.grant.token);
    const snap = (await api('GET', `${g}/snapshot`)).data;
    expect(node(snap, a.id).status).toBe('landed');
    expect(node(snap, b.id)).toMatchObject({ status: 'done', landing: { status: 'conflict', files: ['src/shared.ts'] } });
    expect(snap.events.some((e: any) => e.type === 'claim.landing_failed' && e.claims.includes(b.id))).toBe(true);
    expect((await api('POST', `${g}/claims/${b.id}/reopen`, ADMIN)).status).toBe(200);
    expect((await api('GET', `${g}/ready`)).data.map((c: any) => c.id)).toContain(b.id);
  });
});

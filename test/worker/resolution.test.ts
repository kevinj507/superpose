import { SELF, env, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Graph } from '../../src/graph';
import type { FakeRepoHost } from '../../src/core/fake-host';
const ADMIN = 'test-admin';
const AGENT = 'test-agent';
let seq = 0;
async function api(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await SELF.fetch(`https://superpose.test${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
async function fixture() {
  const gid = `resolution${++seq}`;
  const g = `/api/graphs/${gid}`;
  await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
  const stub = env.GRAPH.get(env.GRAPH.idFromName(gid));
  await runInDurableObject(stub, async (instance: Graph) => {
    (instance.repoHost as FakeRepoHost).commit(`${gid}.line.main`, { 'src/app.ts': 'base' });
  });
  return { gid, g, stub };
}
async function take(g: string, line = 'main') {
  const c = (await api('POST', `${g}/claims`, ADMIN, { statement: `Work on ${line}`, scope: [`src/${line}/**`], line })).data;
  const grant = (await api('POST', `${g}/claims/${c.id}/claim`, AGENT, { agent: line })).data;
  return { c, grant };
}
describe('resolution over HTTP and durable storage', () => {
  it('records an in-scope proposal source commit separately from protected owner adoption', async () => {
    const { gid, g, stub } = await fixture();
    const { c, grant } = await take(g);
    let sourceSha = '';
    await runInDurableObject(stub, async (instance: Graph) => {
      sourceSha = (await (instance.repoHost as FakeRepoHost).commit(`${gid}.claim.${c.id}`, { 'src/main/proposed-check.test.ts': 'proposal check' })).after;
    });
    const article = (await api('POST', `${g}/articles`, grant.token, { finder: c.id, statement: 'Pay the displayed price', check: 'bun test constitution/price.test.ts', sourceFile: 'src/main/proposed-check.test.ts' })).data;
    expect(article.proposal.source).toEqual({ file: 'src/main/proposed-check.test.ts', sha: sourceSha });
    expect((await api('POST', `${g}/articles/${article.id}/adopt`, ADMIN)).status).toBe(400);
    await runInDurableObject(stub, async (instance: Graph) => {
      (instance.repoHost as FakeRepoHost).commit(`${gid}.line.main`, { 'constitution/price.test.ts': 'owner check' });
    });
    const adopted = await api('POST', `${g}/articles/${article.id}/adopt`, ADMIN, { checkFile: 'constitution/price.test.ts' });
    expect(adopted.status).toBe(200);
    expect(adopted.data.proposal).toMatchObject({ source: { file: 'src/main/proposed-check.test.ts', sha: sourceSha }, resolution: 'adopted', atSha: expect.any(String) });
    const outside = await api('POST', `${g}/articles`, grant.token, { finder: c.id, statement: 'Out of scope proposal', sourceFile: 'constitution/forbidden.test.ts' });
    expect(outside.status).toBe(400);
  });

  it('requires owner adoption and an already landed protected check, then persists the decision', async () => {
    const { gid, g, stub } = await fixture();
    const { c, grant } = await take(g);
    const article = (await api('POST', `${g}/articles`, grant.token, { finder: c.id, statement: 'Pay the displayed price',
      check: 'bun test constitution/price.test.ts', checkFile: 'constitution/price.test.ts' })).data;
    expect(article.proposal.resolution).toBeUndefined();
    expect((await api('POST', `${g}/articles/${article.id}/adopt`, grant.token)).status).toBe(401);
    expect((await api('POST', `${g}/articles/${article.id}/adopt`, AGENT)).status).toBe(401);
    expect((await api('POST', `${g}/articles/${article.id}/adopt`, ADMIN)).status).toBe(400);
    await runInDurableObject(stub, async (instance: Graph) => {
      (instance.repoHost as FakeRepoHost).commit(`${gid}.line.main`, { 'constitution/price.test.ts': 'owner check' });
    });
    const adopted = await api('POST', `${g}/articles/${article.id}/adopt`, ADMIN);
    expect(adopted.status).toBe(200);
    expect(adopted.data).toMatchObject({ constitution: true, proposal: { resolution: 'adopted' } });
    await evictAllDurableObjects();
    const snap = (await api('GET', `${g}/snapshot`, ADMIN)).data;
    expect(snap.nodes.find((n: any) => n.id === article.id)).toMatchObject({ constitution: true, proposal: { resolution: 'adopted', atSha: expect.any(String) } });
  });

  it('hides independent group context and exposes a candidate only after owner publication', async () => {
    const { g } = await fixture();
    await api('POST', `${g}/lines/main`, ADMIN, { sharing: 'isolated', group: 'a' });
    await api('POST', `${g}/lines/b`, ADMIN, { from: 'main', sharing: 'isolated', group: 'b' });
    const premise = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'Approach is viable' })).data;
    const first = await take(g);
    const second = await take(g, 'b');
    const finding = (await api('POST', `${g}/findings`, first.grant.token, { finder: first.c.id, statement: 'An important candidate result', effect: 'contradicts', targets: [premise.id] })).data.finding;
    const context = (await api('GET', `${g}/snapshot`, second.grant.token)).data;
    expect(context.nodes.some((n: any) => [first.c.id, finding.id].includes(n.id))).toBe(false);
    expect((await api('GET', `${g}/findings/${finding.id}/impact`, second.grant.token)).status).toBe(404);
    expect((await api('GET', `${g}/why?path=src/app.ts&line=main`, second.grant.token)).status).toBe(404);
    expect((await api('GET', `${g}/snapshot`)).data.nodes.some((n: any) => n.kind === 'claim' || n.kind === 'finding')).toBe(false);
    expect((await api('POST', `${g}/findings/${finding.id}/publish`, first.grant.token, { lines: ['b'] })).status).toBe(401);
    expect((await api('POST', `${g}/findings/${finding.id}/publish`, ADMIN, { lines: ['b'] })).status).toBe(200);
    const published = (await api('GET', `${g}/snapshot`, second.grant.token)).data;
    expect(published.nodes.find((n: any) => n.id === finding.id)).toMatchObject({ status: 'unverified', publishedTo: ['b'] });
    expect(published.nodes.find((n: any) => n.id === second.c.id).status).toBe('claimed');
    expect(JSON.stringify(published)).not.toContain(first.grant.token);
  });

  it('rejects enforcement against a proposal and records owner rejection', async () => {
    const { g } = await fixture();
    const { c, grant } = await take(g);
    const article = (await api('POST', `${g}/articles`, grant.token, { finder: c.id, statement: 'A new proposed promise' })).data;
    const finding = (await api('POST', `${g}/findings`, grant.token, { finder: c.id, statement: 'The proposal fails', targets: [article.id], where: [c.id] })).data.finding;
    expect((await api('POST', `${g}/findings/${finding.id}/verify`, ADMIN)).status).toBe(400);
    expect((await api('POST', `${g}/articles/${article.id}/reject`, ADMIN, { reason: 'Outside the agreed product intent' })).data.proposal).toMatchObject({ resolution: 'rejected' });
    expect((await api('GET', `${g}/snapshot`, grant.token)).data.nodes.find((n: any) => n.id === c.id).status).toBe('claimed');
  });
});

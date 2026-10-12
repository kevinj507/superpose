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

function hostOf<T>(gid: string, fn: (h: FakeRepoHost) => T): Promise<T> {
  const stub = env.GRAPH.get(env.GRAPH.idFromName(gid));
  return runInDurableObject(stub, (instance: Graph) => fn(instance.repoHost as FakeRepoHost));
}

// Claim, commit, finish: in local mode the claim then lands at once.
async function build(gid: string, id: string, files: Record<string, string>) {
  const g = `/api/graphs/${gid}`;
  const grant = (await api('POST', `${g}/claims/${id}/claim`, AGENT, { agent: `agent-${id}` })).data;
  const sha = await hostOf(gid, (h) => h.commit(grant.repo.name, files, `work\n\nSuperpose-Claim: ${id}`).after);
  await api('POST', `${g}/claims/${id}/push`, grant.token, { sha });
  await api('POST', `${g}/claims/${id}/finish`, grant.token);
  return grant;
}

// One decision built two ways: where the visit counters live. Option A (the
// main line) rests on KV being strongly consistent; option B, forked before
// either was built, rests on a Durable Object.
async function twoWays() {
  const gid = `r${++seq}`;
  const g = `/api/graphs/${gid}`;
  await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
  await hostOf(gid, (h) => h.commit(`${gid}.line.main`, { 'index.html': '<h1>counter</h1>' }, 'seed'));
  const forked = await api('POST', `${g}/lines/do`, ADMIN, { from: 'main', decision: 'Where do the counters live?', option: 'a Durable Object' });
  expect(forked.status).toBe(200);
  const labelled = await api('POST', `${g}/lines/main`, ADMIN, { decision: 'Where do the counters live?', option: 'KV' });
  expect(labelled.data).toMatchObject({ name: 'main', served: true, option: 'KV' });
  const kv = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'KV reads are strongly consistent' })).data;
  const dobj = (await api('POST', `${g}/assumptions`, ADMIN, { statement: 'A Durable Object serialises every write' })).data;
  const a = (await api('POST', `${g}/claims`, ADMIN, { statement: 'Counters in KV', scope: ['**'], restsOn: [kv.id] })).data;
  const b = (await api('POST', `${g}/claims`, ADMIN, { statement: 'Counters in a Durable Object', scope: ['**'], restsOn: [dobj.id], line: 'do' })).data;
  const helper = (await api('POST', `${g}/claims`, ADMIN, { statement: 'someone who notices', scope: ['notes/**'] })).data;
  await build(gid, a.id, { 'index.html': '<h1>counter (KV)</h1>' });
  await build(gid, b.id, { 'index.html': '<h1>counter (Durable Object)</h1>' });
  return { gid, g, kv, dobj, a, b, helper };
}

describe('realities: one decision built two ways', () => {
  it('each option lands into its own line, and the main line is the one served', async () => {
    const w = await twoWays();
    const snap = (await api('GET', `${w.g}/snapshot`)).data;
    expect(snap.lines.map((l: any) => [l.name, l.served, !!l.head, l.option])).toEqual([['main', true, true, 'KV'], ['do', false, true, 'a Durable Object']]);
    expect(snap.lines[1]).toMatchObject({ from: 'main', inherits: [], decision: 'Where do the counters live?' });
    const page = await SELF.fetch(`https://superpose.test/served/${w.gid}/`);
    expect(await page.text()).toBe('<h1>counter (KV)</h1>');
    expect(page.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('a finding against the served option shows which reality does not rest on it, and the switch is a pointer change', async () => {
    const w = await twoWays();
    const lease = (await api('POST', `${w.g}/claims/${w.helper.id}/claim`, AGENT, { agent: 'noticer' })).data.token;
    const f = (await api('POST', `${w.g}/findings`, lease, {
      finder: w.helper.id, statement: 'KV is eventually consistent: counters drift', effect: 'contradicts', targets: [w.kv.id],
    })).data.finding;
    const impact = (await api('GET', `${w.g}/findings/${f.id}/impact`)).data;
    expect(impact.realities).toEqual([
      { line: 'main', served: true, affected: [], landedAtRisk: [w.a.id], safe: false },
      { line: 'do', served: false, affected: [], landedAtRisk: [], safe: true },
    ]);
    await api('POST', `${w.g}/findings/${f.id}/verify`, ADMIN);
    expect((await api('POST', `${w.g}/lines/do/serve`, ADMIN)).status).toBe(200);

    const snap = (await api('GET', `${w.g}/snapshot`)).data;
    expect(snap.lines.map((l: any) => [l.name, l.served])).toEqual([['main', false], ['do', true]]);
    expect(snap.events.at(-1)).toMatchObject({ type: 'reality.served', data: { line: 'do', previous: 'main' } });
    // Nothing is deleted: the old reality is still there to retrace.
    expect(snap.nodes.find((n: any) => n.id === w.a.id)).toMatchObject({ status: 'landed', line: 'main' });
    expect(await (await SELF.fetch(`https://superpose.test/served/${w.gid}/index.html`)).text()).toBe('<h1>counter (Durable Object)</h1>');
  });

  it('a line forked after work landed carries that work, and its risks', async () => {
    const w = await twoWays();
    await api('POST', `${w.g}/lines/later`, ADMIN, { from: 'main' });
    const lease = (await api('POST', `${w.g}/claims/${w.helper.id}/claim`, AGENT, { agent: 'noticer' })).data.token;
    const f = (await api('POST', `${w.g}/findings`, lease, {
      finder: w.helper.id, statement: 'KV drifts', effect: 'contradicts', targets: [w.kv.id],
    })).data.finding;
    const later = (await api('GET', `${w.g}/findings/${f.id}/impact`)).data.realities.find((r: any) => r.line === 'later');
    expect(later).toEqual({ line: 'later', served: false, affected: [], landedAtRisk: [w.a.id], safe: false });
  });

  it('refuses paths that climb out of the repo', async () => {
    const w = await twoWays();
    // Plain dots are resolved by URL parsing before they arrive; encoded
    // slashes are not, so they are checked here.
    expect((await SELF.fetch(`https://superpose.test/served/${w.gid}/a%2F..%2F..%2Fsecret`)).status).toBe(400);
  });
});

describe('why a file is the way it is', () => {
  it('names the landed claims that changed it in the served reality, with what they rested on', async () => {
    const w = await twoWays();
    const why = (await api('GET', `${w.g}/why?path=index.html`)).data;
    expect(why).toEqual([
      expect.objectContaining({
        claim: w.a.id, line: 'main', statement: 'Counters in KV',
        assumptions: [expect.objectContaining({ statement: 'KV reads are strongly consistent', status: 'holding' })],
      }),
    ]);
    const other = (await api('GET', `${w.g}/why?path=index.html&line=do`)).data;
    expect(other.map((e: any) => e.claim)).toEqual([w.b.id]);
    expect((await api('GET', `${w.g}/why?path=nothing.txt`)).data).toEqual([]);
  });
});

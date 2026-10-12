import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { FakeRepoHost } from '../../src/core/fake-host';
import type { Graph } from '../../src/graph';
import { handlePush, type ArtifactsEvent } from '../../src/push-flow';

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

function host<T>(gid: string, fn: (h: FakeRepoHost) => T): Promise<T> {
  const stub = env.GRAPH.get(env.GRAPH.idFromName(gid));
  return runInDurableObject(stub, (instance: Graph) => fn(instance.repoHost as FakeRepoHost));
}

// A graph with a seeded line and two claimed claims side by side.
async function twoClaims() {
  const gid = `p${++seq}`;
  const g = `/api/graphs/${gid}`;
  await api('POST', `${g}/lines/main/access`, ADMIN, { scope: 'write' });
  await host(gid, (h) => h.commit(`${gid}.line.main`, { 'package.json': '{}', 'src/api/a.ts': 'a', 'src/ui/b.ts': 'b' }, 'seed'));
  const api1 = (await api('POST', `${g}/claims`, ADMIN, { statement: 'the API', scope: ['src/api/**'] })).data;
  const ui = (await api('POST', `${g}/claims`, ADMIN, { statement: 'the UI', scope: ['src/ui/**'] })).data;
  const a = (await api('POST', `${g}/claims/${api1.id}/claim`, AGENT, { agent: 'agent-api' })).data;
  const b = (await api('POST', `${g}/claims/${ui.id}/claim`, AGENT, { agent: 'agent-ui' })).data;
  return { gid, g, api: { ...api1, lease: a.token, repo: a.repo.name }, ui: { ...ui, lease: b.token, repo: b.repo.name } };
}

// What the trigger hands the Workflow for a push to `repo`.
function event(repo: string, push: { before: string | null; after: string; message: string }, ref = 'refs/heads/main'): ArtifactsEvent {
  return {
    id: `evt-${push.after.slice(0, 8)}`,
    type: 'cf.artifacts.repo.pushed',
    source: { namespace: 'superpose', repoName: repo },
    payload: { ref, before: push.before ?? '0'.repeat(40), after: push.after, commits: [{ id: push.after, message: push.message }] },
  };
}

describe('push events', () => {
  it('a push is checked against the claim\'s scope from the commit itself, and becomes the claim\'s head', async () => {
    const w = await twoClaims();
    const push = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': 'a2', 'src/api/new.ts': 'n' }, `api\n\nSuperpose-Claim: ${w.api.id}`));
    const handled = await handlePush(env, event(w.api.repo, push));
    expect(handled).toMatchObject({
      claim: w.api.id,
      record: { sha: push.after, accepted: true, verdict: 'unverified', paths: ['src/api/a.ts', 'src/api/new.ts'], outside: [] },
    });
    const snap = (await api('GET', `${w.g}/snapshot`)).data;
    expect(snap.nodes.find((n: any) => n.id === w.api.id)).toMatchObject({ headSha: push.after, pushes: 1 });
    expect(snap.pushes).toHaveLength(1);
  });

  it('ignores repos that are not Superpose\'s and pushes to other branches do not move the head', async () => {
    const w = await twoClaims();
    expect(await handlePush(env, event('someone-elses-repo', { before: null, after: 'f'.repeat(40), message: 'x' }))).toEqual({
      ignored: 'not a Superpose repo: someone-elses-repo',
    });
    const push = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': 'side' }, 'side branch'));
    const handled = await handlePush(env, event(w.api.repo, push, 'refs/heads/experiment'));
    expect(handled).toMatchObject({ record: { accepted: false, reason: 'other-branch' } });
  });

  it('a push outside the scope is flagged, and the claim whose scope it entered hears of it at renewal', async () => {
    const w = await twoClaims();
    const push = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': 'a2', 'src/ui/b.ts': 'changed by the API agent' }, `x\n\nSuperpose-Claim: ${w.api.id}`));
    const handled = await handlePush(env, event(w.api.repo, push));
    expect(handled).toMatchObject({ record: { verdict: 'scope-violation', outside: ['src/ui/b.ts'] } });
    const renewal = (await api('POST', `${w.g}/claims/${w.ui.id}/renew`, w.ui.lease)).data;
    expect(renewal.notices).toEqual([
      expect.objectContaining({ type: 'scope.touched', data: { by: w.api.id, sha: push.after, paths: ['src/ui/b.ts'] } }),
    ]);
  });

  it('events that arrive out of order leave the newest commit as the head', async () => {
    const w = await twoClaims();
    const first = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': '1' }, `1\n\nSuperpose-Claim: ${w.api.id}`));
    const second = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': '2' }, `2\n\nSuperpose-Claim: ${w.api.id}`));
    await handlePush(env, event(w.api.repo, second));
    const late = await handlePush(env, event(w.api.repo, first));
    expect(late).toMatchObject({ record: { sha: first.after, accepted: false, reason: 'not-head' } });
    const snap = (await api('GET', `${w.g}/snapshot`)).data;
    expect(snap.nodes.find((n: any) => n.id === w.api.id).headSha).toBe(second.after);
  });

  it('the agent\'s own report and the push event make one ledger row', async () => {
    const w = await twoClaims();
    const push = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': 'x' }, 'no trailer'));
    const reported = await api('POST', `${w.g}/claims/${w.api.id}/push`, w.api.lease, { sha: push.after });
    expect(reported.data).toMatchObject({ accepted: true, verdict: 'unverified' });
    await handlePush(env, event(w.api.repo, push));
    const snap = (await api('GET', `${w.g}/snapshot`)).data;
    expect(snap.pushes.filter((r: any) => r.sha === push.after)).toHaveLength(1);
    expect(snap.nodes.find((n: any) => n.id === w.api.id).pushes).toBe(1);
  });

  it('flags commits that do not name their claim', async () => {
    const w = await twoClaims();
    const push = await host(w.gid, (h) => h.commit(w.api.repo, { 'src/api/a.ts': 'x' }, 'forgot the trailer'));
    expect(await handlePush(env, event(w.api.repo, push))).toMatchObject({ record: { unattributed: [push.after] } });
  });

  it('a commit the repo does not have is refused, not recorded', async () => {
    const w = await twoClaims();
    const r = await api('POST', `${w.g}/claims/${w.api.id}/push`, w.api.lease, { sha: 'a'.repeat(40) });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe('unknown_commit');
  });
});

describe('reporting spend', () => {
  it('never hands back the claim, whose lease token belongs to its holder', async () => {
    const w = await twoClaims();
    const r = await api('POST', `${w.g}/claims/${w.api.id}/spend`, AGENT, { usd: 0.01, turns: 3 });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain(w.api.lease);
    expect(r.data).toMatchObject({ usd: 0.01, turns: 3, runs: 1 });
  });
});

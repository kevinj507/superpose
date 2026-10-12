#!/usr/bin/env node
// Layer 2 of the test plan: 100 scripted agents against the real, deployed
// Superpose. They hold real leases (each with its own Artifacts repo and git
// token) and renew on a clock. A finding against one assumption is filed,
// left unverified for a while (the hedge), then verified. Measured:
//   - how long each affected agent takes to hear (target: within one renewal)
//   - notices that reach the wrong agents (target: 0)
//   - pushes from stale claims accepted after verification (target: 0)
//   - the cost reported before the finding fired
//
//   SUPERPOSE_URL=https://superpose.kevinj507.workers.dev \
//   SUPERPOSE_ADMIN_TOKEN=... SUPERPOSE_AGENT_KEY=... node sim/layer2.mjs [--agents 100] [--renew 15]
//
// Cleans up its Artifacts repos at the end when CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID are set.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL_ = process.env.SUPERPOSE_URL ?? 'https://superpose.kevinj507.workers.dev';
const ADMIN = process.env.SUPERPOSE_ADMIN_TOKEN;
const AGENT = process.env.SUPERPOSE_AGENT_KEY;
const N = Number(arg('agents', 100));
const RENEW_S = Number(arg('renew', 15)); // each agent renews this often
const HEDGE_S = Number(arg('hedge', 20)); // how long the finding stays unverified
const GRAPH = arg('graph', `sim-${Date.now().toString(36)}`);
if (!ADMIN || !AGENT) throw new Error('set SUPERPOSE_ADMIN_TOKEN and SUPERPOSE_AGENT_KEY');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(method, path, token, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${URL_}/api/graphs/${GRAPH}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (res.status >= 500 && attempt < 4) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    return { status: res.status, data };
  }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// ---- the plan: assumption A carries 12 claims (9 directly, 3 through a
// claim built on one of those), assumption B the rest --------------------------

log(`graph ${GRAPH}: ${N} agents, renewing every ${RENEW_S}s`);
const seed = (await api('POST', '/lines/main/access', ADMIN, { scope: 'write', ttl: 900 })).data;
const seedDir = mkdtempSync(join(tmpdir(), 'sp-seed-'));
git(seedDir, 'init', '-q', '-b', 'main');
writeFileSync(join(seedDir, 'README.md'), 'layer 2 simulation\n');
git(seedDir, 'add', '-A');
git(seedDir, '-c', 'user.name=Superpose sim', '-c', 'user.email=sim@superpose.invalid', 'commit', '-qm', 'seed');
git(seedDir, '-c', `http.extraHeader=Authorization: Bearer ${seed.token}`, 'push', '-q', seed.remote, 'main');
rmSync(seedDir, { recursive: true, force: true });

const A = (await api('POST', '/assumptions', ADMIN, { statement: 'Session timestamps are UTC everywhere' })).data;
const B = (await api('POST', '/assumptions', ADMIN, { statement: 'Requests are authenticated upstream' })).data;
const direct = [];
for (let i = 1; i <= 9; i++) direct.push((await api('POST', '/claims', ADMIN, { statement: `direct ${i}`, scope: [`src/d${i}/**`], restsOn: [A.id] })).data);
const others = [];
for (let i = 1; i <= N - 12; i++) others.push((await api('POST', '/claims', ADMIN, { statement: `other ${i}`, scope: [`src/o${i}/**`], restsOn: [B.id] })).data);
log(`planned ${direct.length + others.length} claims`);

// Every agent records what it hears and when.
const agents = new Map(); // claim id -> { lease, git, heard: [{at, type}], stale }
async function claim(c, name) {
  const r = await api('POST', `/claims/${c.id}/claim`, AGENT, { agent: name });
  if (r.status !== 200) throw new Error(`claim ${c.id}: ${r.status} ${JSON.stringify(r.data)}`);
  agents.set(c.id, { id: c.id, name, lease: r.data.token, git: r.data.git, repo: r.data.repo, heard: [], stale: false });
}
const t0 = now();
await pool([...direct, ...others], 10, (c, k) => claim(c, `sim-${k + 1}`));
log(`${agents.size} claims taken (each forked a repo and got a lease-scoped token) in ${((now() - t0) / 1000).toFixed(1)}s`);

// Three claims built on direct claims: their dependency finishes (no commits,
// so it lands as is) and they become ready.
const indirect = [];
for (let i = 0; i < 3; i++) {
  const d = direct[i];
  indirect.push((await api('POST', '/claims', ADMIN, { statement: `built on direct ${i + 1}`, scope: [`src/i${i + 1}/**`], requires: [d.id] })).data);
  await api('POST', `/claims/${d.id}/finish`, agents.get(d.id).lease);
  agents.delete(d.id);
}
for (const [k, c] of indirect.entries()) await claim(c, `sim-indirect-${k + 1}`);
const affectedIds = new Set([...direct.slice(3), ...indirect].map((c) => c.id));
log(`affected set: ${affectedIds.size} live agents rest on A (6 direct + 3 through a landed claim; the 3 finished ones are landed work)`);

// ---- agents renew on a clock ------------------------------------------------

let running = true;
const renewals = { ok: 0, stale: 0, failed: 0 };
async function live(agent) {
  await sleep(Math.random() * RENEW_S * 1000); // spread the renewals
  while (running) {
    const r = await api('POST', `/claims/${agent.id}/renew`, agent.lease);
    const at = now();
    if (r.status === 200) {
      for (const n of r.data.notices ?? []) agent.heard.push({ at, type: n.type, data: n.data });
      if (r.data.ok) {
        renewals.ok++;
        if (r.data.git) agent.git = r.data.git;
      } else {
        renewals.stale++;
        agent.stale = true;
      }
    } else renewals.failed++;
    await sleep(RENEW_S * 1000);
  }
}
const loops = [...agents.values()].map((a) => live(a));
await sleep(RENEW_S * 1000 + 2000);
log(`all agents renewing (${renewals.ok} renewals so far)`);

// ---- the finding: filed (a hedge), then verified -----------------------------

const finder = agents.get(others[49].id);
const filed = (await api('POST', '/findings', finder.lease, {
  finder: finder.id, statement: 'Mobile clients send local time, not UTC', effect: 'contradicts', targets: [A.id],
})).data.finding;
const impact = (await api('GET', `/findings/${filed.id}/impact`)).data;
log(`finding ${filed.id} filed, unverified. Reported before firing: ${impact.affected.length} claims would go stale, cost ${impact.cost}, landed at risk ${impact.landedAtRisk.length}`);
const tFiled = now();
await sleep(HEDGE_S * 1000);
const heardDuringHedge = [...agents.values()].filter((a) => a.id !== finder.id && a.heard.some((h) => h.at >= tFiled));

const tVerified = now();
await api('POST', `/findings/${filed.id}/verify`, ADMIN);
log(`finding verified; waiting ${RENEW_S + 5}s for every agent's next renewal`);
await sleep((RENEW_S + 5) * 1000);

// ---- stale pushes after verification: git accepts them (the token is still
// valid until the lease ends), Superpose must not ------------------------------

const staleAgents = [...agents.values()].filter((a) => affectedIds.has(a.id)).slice(0, 4);
const pushed = [];
for (const a of staleAgents) {
  const dir = mkdtempSync(join(tmpdir(), 'sp-stale-'));
  try {
    git(dir, '-c', `http.extraHeader=Authorization: Bearer ${a.git.token}`, 'clone', '-q', a.repo.remote, '.');
    writeFileSync(join(dir, `late-${a.id}.txt`), 'pushed after the finding was verified\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Superpose sim', '-c', 'user.email=sim@superpose.invalid', 'commit', '-qm', `late work\n\nSuperpose-Claim: ${a.id}`);
    git(dir, '-c', `http.extraHeader=Authorization: Bearer ${a.git.token}`, 'push', '-q', 'origin', 'main');
    pushed.push({ claim: a.id, sha: git(dir, 'rev-parse', 'HEAD') });
  } catch (err) {
    pushed.push({ claim: a.id, error: String(err.stderr ?? err).slice(0, 200) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
await sleep(30_000); // let the push events through the Workflow

running = false;
await Promise.all(loops);

// ---- measure ------------------------------------------------------------------

const snap = (await api('GET', '/snapshot')).data;
const latencies = [];
const missed = [];
for (const id of affectedIds) {
  const a = agents.get(id);
  const heard = a.heard.find((h) => h.type === 'claim.stale');
  if (heard) latencies.push((heard.at - tVerified) / 1000);
  else missed.push(id);
}
const wrong = [...agents.values()].filter((a) => !affectedIds.has(a.id) && a.id !== finder.id && a.heard.some((h) => h.type === 'claim.stale'));
const ledger = pushed.filter((p) => p.sha).map((p) => snap.pushes.find((r) => r.claim === p.claim && r.sha === p.sha));
const staleAccepted = ledger.filter((r) => r && r.accepted).length;
const staleRecorded = ledger.filter((r) => r && !r.accepted && r.reason === 'stale').length;
const staleNow = snap.nodes.filter((n) => n.kind === 'claim' && n.status === 'stale').map((n) => n.id);
latencies.sort((x, y) => x - y);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];

const report = {
  graph: GRAPH,
  agents: agents.size,
  renewIntervalSeconds: RENEW_S,
  renewals,
  reportedBeforeFiring: { wouldGoStale: impact.affected.length, cost: impact.cost, landedAtRisk: impact.landedAtRisk.length },
  hedge: { seconds: HEDGE_S, agentsStoppedOrNotified: heardDuringHedge.length },
  delivery: {
    affected: affectedIds.size,
    heard: latencies.length,
    missed,
    secondsAfterVerification: { min: latencies[0], p50: pct(50), p90: pct(90), max: latencies.at(-1) },
    withinOneRenewal: latencies.filter((s) => s <= RENEW_S + 2).length,
  },
  wrongNotifications: wrong.map((a) => a.id),
  stalePushes: { attempted: pushed.length, pushedToGit: ledger.length, recordedAsStale: staleRecorded, accepted: staleAccepted, errors: pushed.filter((p) => p.error) },
  staleInGraph: staleNow.length,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`sim-report-${GRAPH}.json`, JSON.stringify(report, null, 2));

// ---- clean up the repos ---------------------------------------------------------

if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && !process.argv.includes('--keep')) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/superpose/repos`;
  const names = [`${GRAPH}.line.main`, ...snap.nodes.filter((n) => n.kind === 'claim' && n.repo).map((n) => n.repo.name)];
  await pool(names, 8, (name) => fetch(`${base}/${name}`, { method: 'DELETE', headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }));
  log(`deleted ${names.length} repos`);
}

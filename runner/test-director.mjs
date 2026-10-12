#!/usr/bin/env node
// The human's part in an experiment run, scripted, so runs can be compared:
// every finding is verified once it has run beside the work as a hedge for a
// while. With --integrate, a verified finding that puts landed work at risk
// gets a new claim to make that work right again, the way a person reading
// the impact would plan integration work. Every decision is printed, with
// its time, for the run's record.
//
//   node runner/test-director.mjs --graph <gid> [--hedge 30] [--timeout 3600] [--integrate]
// Needs SUPERPOSE_ADMIN_TOKEN (and SUPERPOSE_URL unless the hosted one).

import { parseArgs } from 'node:util';
import { Api, serviceUrl, sleep } from './lib.mjs';

const { values } = parseArgs({
  options: {
    graph: { type: 'string' },
    hedge: { type: 'string', default: '30' },
    timeout: { type: 'string', default: '3600' },
    integrate: { type: 'boolean', default: false },
    url: { type: 'string' },
  },
});
const admin = process.env.SUPERPOSE_ADMIN_TOKEN;
if (!values.graph || !admin) {
  console.error('usage: SUPERPOSE_ADMIN_TOKEN=... node runner/test-director.mjs --graph <gid> [--hedge 30] [--integrate]');
  process.exit(2);
}
const api = new Api(serviceUrl(values.url), values.graph);
const hedgeMs = Number(values.hedge) * 1000;
const deadline = Date.now() + Number(values.timeout) * 1000;
const say = (text) => console.log(`[director ${new Date().toISOString().slice(11, 19)}] ${text}`);

const seenAt = new Map(); // finding id -> when first seen unverified
const handled = new Set();
say(`watching ${values.graph}: findings are verified after ${values.hedge}s${values.integrate ? '; landed work at risk gets an integration claim' : ''}`);
while (Date.now() < deadline) {
  await sleep(3000);
  const snap = await api.snapshot();
  if (!snap.ok) continue;
  const nodes = snap.data.nodes;
  const claims = new Map(nodes.filter((n) => n.kind === 'claim').map((n) => [n.id, n]));
  for (const f of nodes.filter((n) => n.kind === 'finding' && n.status === 'unverified' && !handled.has(n.id))) {
    if (!seenAt.has(f.id)) {
      seenAt.set(f.id, Date.now());
      say(`seen ${f.id} (${f.effect} ${(f.targets ?? []).join(', ')}) from ${f.finder ?? '?'}: ${f.statement}`);
    }
    if (Date.now() - seenAt.get(f.id) < hedgeMs) continue;
    const impact = f.effect === 'contradicts' ? await api.impact(f.id) : null;
    if (impact?.ok) say(`impact of ${f.id}: stops ${impact.data.affected.join(', ') || 'none'}; landed at risk ${impact.data.landedAtRisk.join(', ') || 'none'}`);
    const r = await api.verify(admin, f.id);
    if (!r.ok) {
      say(`could not verify ${f.id}: ${JSON.stringify(r.data)}`);
      if (r.status < 500) handled.add(f.id);
      continue;
    }
    handled.add(f.id);
    say(`verified ${f.id}`);
    if (!values.integrate || !impact?.ok || !impact.data.landedAtRisk.length) continue;
    // One integration claim per line that holds work at risk.
    const byLine = new Map();
    for (const id of impact.data.landedAtRisk) {
      const c = claims.get(id);
      if (!c) continue;
      if (!byLine.has(c.line ?? 'main')) byLine.set(c.line ?? 'main', []);
      byLine.get(c.line ?? 'main').push(c);
    }
    for (const [line, atRisk] of byLine) {
      const statement =
        `Make the product right again after finding ${f.id}: ${f.statement} ` +
        `This landed work rests on what the finding showed false; change it so it no longer does, with a test: ` +
        atRisk.map((c) => `${c.id} (${c.statement})`).join('; ');
      const scope = [...new Set(atRisk.flatMap((c) => c.scope))];
      const added = await api.addClaim(admin, { statement, scope, line });
      say(added.ok ? `planned ${added.data.id} on ${line} to rework ${atRisk.map((c) => c.id).join(', ')}` : `could not plan integration work: ${JSON.stringify(added.data)}`);
    }
  }
  const open = [...claims.values()].some((c) => !['landed', 'superseded'].includes(c.status));
  const pending = nodes.some((n) => n.kind === 'finding' && n.status === 'unverified' && !handled.has(n.id));
  if (!open && !pending && claims.size) {
    say('every claim has landed and no finding is waiting');
    break;
  }
}
say('stopped');

#!/usr/bin/env node
// The human's part in the playground, scripted: watch a graph, verify the
// first finding once it has run beside the others as a hedge for a while,
// and when the line that does not rest on it has landed all its claims,
// switch the served reality to it.
//
//   node runner/play-director.mjs --graph <gid> [--hedge 20] [--timeout 1500]
// Needs SUPERPOSE_ADMIN_TOKEN (and SUPERPOSE_URL unless the hosted one).

import { parseArgs } from 'node:util';
import { Api, serviceUrl, sleep } from './lib.mjs';

const { values } = parseArgs({
  options: { graph: { type: 'string' }, hedge: { type: 'string', default: '20' }, timeout: { type: 'string', default: '1500' }, url: { type: 'string' } },
});
const admin = process.env.SUPERPOSE_ADMIN_TOKEN;
if (!values.graph || !admin) {
  console.error('usage: SUPERPOSE_ADMIN_TOKEN=... node runner/play-director.mjs --graph <gid>');
  process.exit(2);
}
const api = new Api(serviceUrl(values.url), values.graph);
const hedgeMs = Number(values.hedge) * 1000;
const deadline = Date.now() + Number(values.timeout) * 1000;
const say = (text) => console.log(`[director ${new Date().toISOString().slice(11, 19)}] ${text}`);

let seenAt = null;
let verified = false;
let switched = false;
while (Date.now() < deadline && !switched) {
  await sleep(3000);
  const snap = await api.snapshot();
  if (!snap.ok) continue;
  const { nodes, lines } = snap.data;
  const finding = nodes.find((n) => n.kind === 'finding' && n.effect === 'contradicts');
  if (finding && finding.status === 'unverified' && !verified) {
    seenAt ??= Date.now();
    if (Date.now() - seenAt >= hedgeMs) {
      const impact = await api.impact(finding.id);
      if (impact.ok) say(`verifying ${finding.id}: ${impact.data.affected.length} claims would stop, ${impact.data.landedAtRisk.length} landed at risk; safe: ${impact.data.realities.filter((r) => r.safe).map((r) => r.line).join(', ') || 'none'}`);
      const r = await api.verify(admin, finding.id);
      say(r.ok ? `verified ${finding.id}` : `could not verify: ${JSON.stringify(r.data)}`);
      verified = r.ok;
    }
  }
  if (verified && finding) {
    const impact = await api.impact(finding.id);
    const safe = impact.ok ? impact.data.realities.find((r) => r.safe && !r.served) : null;
    if (!safe) continue;
    const onLine = nodes.filter((n) => n.kind === 'claim' && n.line === safe.line);
    if (onLine.length && onLine.every((c) => c.status === 'landed')) {
      const r = await api.request('POST', `/lines/${safe.line}/serve`, { token: admin });
      say(r.ok ? `now serving ${safe.line}` : `could not switch: ${JSON.stringify(r.data)}`);
      switched = r.ok;
    }
  }
  void lines;
}
say(switched ? 'done' : 'stopped waiting');

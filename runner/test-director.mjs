#!/usr/bin/env node
// Script explicit owner choices from a frozen JSON policy. The default only
// requests executable checks; elapsed time never supplies verification.
// bun runner/test-director.mjs --graph <gid> [--policy file.json] [--integrate]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Api, serviceUrl, sleep } from './lib.mjs';
import { directorActions } from './director-policy.mjs';

const { values } = parseArgs({ options: {
  graph: { type: 'string' }, policy: { type: 'string' }, timeout: { type: 'string', default: '3600' },
  integrate: { type: 'boolean', default: false }, url: { type: 'string' },
} });
const admin = process.env.SUPERPOSE_ADMIN_TOKEN;
if (!values.graph || !admin) {
  console.error('usage: bun runner/test-director.mjs --graph <gid> [--policy file.json] [--integrate]; needs SUPERPOSE_ADMIN_TOKEN');
  process.exit(2);
}
const policy = values.policy ? JSON.parse(readFileSync(values.policy, 'utf8')) : {};
const seconds = Number(values.timeout);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('timeout must be positive seconds');
const api = new Api(serviceUrl(values.url), values.graph, admin);
const deadline = Date.now() + seconds * 1000;
const say = (text) => console.log(`[director ${new Date().toISOString()}] ${text}`);
const handled = new Set();
const integrated = new Set();
say(`watching ${values.graph}; elapsed time never verifies or adopts a statement`);
while (Date.now() < deadline) {
  await sleep(3000);
  const snap = await api.snapshot();
  if (!snap.ok) continue;
  const nodes = snap.data.nodes;
  for (const choice of directorActions(nodes, policy)) {
    const key = `${choice.id}:${choice.action}`;
    if (handled.has(key)) continue;
    const article = choice.action === 'adopt' || choice.action === 'reject';
    const body = article ? { reason: choice.reason, judged: choice.judged === true, check: choice.check, checkFile: choice.checkFile } :
      choice.action === 'publish' ? { lines: choice.lines } : undefined;
    const r = await api.request('POST', `/${article ? 'articles' : 'findings'}/${choice.id}/${choice.action}`, { token: admin, body });
    say(`${choice.action} ${choice.id}: ${choice.reason}; ${r.ok ? (r.data?.queued === false ? 'no check queued; judgment remains pending' : 'accepted') : `HTTP ${r.status} ${r.data?.error ?? ''}`}`);
    // Failed/inconclusive checks require a fresh owner choice, not retries
    // that quietly turn a clock or platform failure into a verdict.
    if (r.ok || (r.status >= 400 && r.status < 500)) handled.add(key);
  }
  const claims = new Map(nodes.filter((n) => n.kind === 'claim').map((n) => [n.id, n]));
  if (values.integrate) for (const f of nodes.filter((n) => n.kind === 'finding' && n.status === 'verified' && n.effect === 'contradicts' && !integrated.has(n.id))) {
    const impact = await api.impact(f.id);
    if (!impact.ok) continue;
    const byLine = new Map();
    for (const id of impact.data.landedAtRisk) {
      const c = claims.get(id);
      if (!c) continue;
      const line = c.line ?? 'main';
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(c);
    }
    let complete = true;
    for (const [line, atRisk] of byLine) {
      const key = `${f.id}:${line}`;
      if (integrated.has(key)) continue;
      const added = await api.addClaim(admin, {
        statement: `Repair work affected by finding ${f.id}: ${f.statement}. Check the repair for ${atRisk.map((c) => c.id).join(', ')}.`,
        scope: [...new Set(atRisk.flatMap((c) => c.scope))], line,
      });
      if (added.ok) { integrated.add(key); say(`planned ${added.data.id} on ${line} for ${f.id}`); }
      else { complete = false; say(`could not plan repair for ${f.id} on ${line}: HTTP ${added.status}`); }
    }
    if (complete) integrated.add(f.id);
  }
  const open = [...claims.values()].some((c) => !['landed', 'superseded'].includes(c.status));
  const pending = nodes.some((n) => (n.kind === 'finding' && n.status === 'unverified') || (n.proposal && !n.proposal.resolution));
  if (!open && !pending && claims.size) { say('every claim has landed and every finding and proposal is settled'); break; }
}
say('stopped; unresolved items retain their uncertainty');

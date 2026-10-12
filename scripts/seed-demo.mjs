#!/usr/bin/env node
// Plan a demo graph through the public HTTP API, put agents to work on it, and
// play the headline scene: one finding lands, the claims resting on the
// assumption it contradicts go stale, everyone else keeps working.
//
//   node scripts/seed-demo.mjs seed            plan the graph, claim most of it
//   node scripts/seed-demo.mjs hedge           file an unverified finding (it stays a hedge)
//   node scripts/seed-demo.mjs live            keep the agents renewing (Ctrl-C to stop)
//   node scripts/seed-demo.mjs scene           file the time-zone finding, wait, verify it
//                                              (6 claims go stale, 1 landed claim is at risk)
//   node scripts/seed-demo.mjs replan          re-plan the stale claims onto a new assumption
//   node scripts/seed-demo.mjs all             seed + hedge, then live with the scene and re-plan on a timer
//
// Options (or env):
//   --base URL         SUPERPOSE_URL           default http://localhost:8790
//   --graph ID         SUPERPOSE_GRAPH         default demo
//   --admin TOKEN      SUPERPOSE_ADMIN_TOKEN   (env read only for a remote --base; local default dev-admin)
//   --agent KEY        SUPERPOSE_AGENT_KEY     (env read only for a remote --base; local default dev-agent)
//   --verify-after S   seconds between filing and verifying in `scene` (default 12)
//   --scene-after S    `all`: seconds of live work before the scene (default 25)
//   --replan-after S   `live`/`all`: re-plan stale claims S seconds after their agent is told (default off; `all` uses 20)
//   --force            seed even if the graph already has nodes
//
// Lease tokens are secrets: they are kept in .wrangler/superpose-demo-<graph>.json
// (git-ignored) so later commands can act as the same agents.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VALUED = new Set(['base', 'graph', 'admin', 'agent', 'verify-after', 'scene-after', 'replan-after']);
const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (VALUED.has(name)) opts[name] = process.argv[++i];
    else opts[name] = true;
  } else positional.push(a);
}
const flag = (name, env, dflt) => opts[name] ?? process.env[env] ?? dflt;
const command = positional[0] ?? 'seed';
const BASE = String(flag('base', 'SUPERPOSE_URL', 'http://localhost:8790')).replace(/\/$/, '');
const GRAPH = flag('graph', 'SUPERPOSE_GRAPH', 'demo');
// A local dev server uses the tokens in .dev.vars; only a remote base reads the
// real ones from the environment, so they are never sent anywhere by accident.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE);
const ADMIN = opts.admin ?? (LOCAL ? 'dev-admin' : process.env.SUPERPOSE_ADMIN_TOKEN);
const AGENT = opts.agent ?? (LOCAL ? 'dev-agent' : process.env.SUPERPOSE_AGENT_KEY);
const VERIFY_AFTER = Number(flag('verify-after', 'SUPERPOSE_VERIFY_AFTER', '12'));
const SCENE_AFTER = Number(flag('scene-after', 'SUPERPOSE_SCENE_AFTER', '25'));
const REPLAN_AFTER = Number(flag('replan-after', 'SUPERPOSE_REPLAN_AFTER', command === 'all' ? '20' : '0'));
const FORCE = !!opts.force;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, '.wrangler', `superpose-demo-${GRAPH}.json`);
const G = `${BASE}/api/graphs/${encodeURIComponent(GRAPH)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ plan --

// The project: an invoicing app, "Ledgerline", built by ~30 agents at once.
const ASSUMPTIONS = {
  tz: 'The date library handles time zones correctly',
  auth: 'Every request is authenticated upstream at the gateway',
  ids: 'Customer ids are stable UUIDs',
  pay: "The payment provider's v2 API stays available",
  immut: 'Issued invoices are never edited, only credited',
  pg: 'Postgres is the only datastore',
  cents: 'Money fits in 64-bit integer cents',
  a11y: "The design system's components are accessible as shipped",
};

// state: open (left for later), claimed, or landed (claimed, finished, and
// merged into the line). `after` lists claims (by key) this one builds on; a
// claim can be taken only once those have landed.
const CLAIMS = [
  // tz: the assumption the headline finding contradicts
  { key: 'tzImport', statement: 'Parse ISO-8601 dates in the invoice importer', scope: ['src/import/dates.ts', 'src/import/dates.test.ts'], rests: ['tz'], state: 'landed', cluster: 'billing' },
  { key: 'tzDue', statement: "Show due dates in each customer's own time zone", scope: ['web/src/invoices/DueDate.tsx'], rests: ['tz'], state: 'claimed', cluster: 'web' },
  { key: 'tzDunning', statement: 'Send dunning reminders at 9am local time', scope: ['src/dunning/**'], rests: ['tz'], state: 'claimed', cluster: 'billing' },
  { key: 'tzMonthly', statement: 'Bucket revenue by calendar month for reports', scope: ['src/reports/monthly.ts'], rests: ['tz', 'cents'], state: 'claimed', cluster: 'reporting' },
  { key: 'tzCsv', statement: 'Import invoices from accounting CSV exports', scope: ['src/import/csv/**'], rests: ['ids'], after: ['tzImport'], state: 'claimed', cluster: 'billing' },
  { key: 'tzChart', statement: 'Monthly revenue chart on the dashboard', scope: ['web/src/dashboard/Revenue*.tsx'], after: ['tzMonthly'], state: 'open', cluster: 'web' },
  { key: 'tzLate', statement: 'Accrue late fees daily after the due date', scope: ['src/fees/late.ts'], rests: ['cents'], after: ['tzDunning'], state: 'open', cluster: 'billing' },
  // auth
  { key: 'authHeader', statement: "Read the user id from the gateway's signed header", scope: ['src/auth/header.ts'], rests: ['auth'], state: 'claimed', cluster: 'platform' },
  { key: 'authScope', statement: "Scope every invoice query to the caller's workspace", scope: ['src/db/scoping.ts'], rests: ['auth'], state: 'claimed', cluster: 'platform' },
  { key: 'authAudit', statement: 'Audit log for invoice credits and voids', scope: ['src/audit/**'], rests: ['auth', 'immut'], state: 'claimed', cluster: 'platform' },
  { key: 'authInvite', statement: 'Invite teammates from the admin page', scope: ['web/src/admin/Invite*.tsx'], rests: ['auth'], state: 'claimed', cluster: 'web' },
  { key: 'authRate', statement: 'Rate-limit the public API per workspace', scope: ['src/api/ratelimit.ts'], rests: ['auth'], state: 'claimed', cluster: 'platform' },
  // ids
  { key: 'idsLookup', statement: 'Customer lookup by id with a 60-second cache', scope: ['src/customers/lookup.ts'], rests: ['ids'], state: 'claimed', cluster: 'billing' },
  { key: 'idsMerge', statement: 'Merge duplicate customers', scope: ['src/customers/merge.ts'], rests: ['ids'], state: 'claimed', cluster: 'billing' },
  { key: 'idsDetail', statement: 'Customer detail page with invoice history', scope: ['web/src/customers/Detail.tsx'], rests: ['ids'], state: 'claimed', cluster: 'web' },
  { key: 'idsExport', statement: 'Export customers to CSV', scope: ['src/export/customers.ts'], rests: ['ids'], state: 'claimed', cluster: 'reporting' },
  // pay: the assumption the hedge finding doubts
  { key: 'payCharge', statement: 'Charge saved cards on the due date', scope: ['src/payments/charge.ts'], rests: ['pay'], state: 'landed', cluster: 'payments' },
  { key: 'payRefund', statement: 'Refunds through the payment provider', scope: ['src/payments/refunds.ts'], rests: ['pay'], state: 'claimed', cluster: 'payments' },
  { key: 'payHooks', statement: "Handle the provider's payment webhooks", scope: ['src/payments/webhooks/**'], rests: ['pay'], state: 'claimed', cluster: 'payments' },
  { key: 'payRetry', statement: 'Retry failed charges with backoff', scope: ['src/payments/retry.ts'], after: ['payCharge'], state: 'claimed', cluster: 'payments' },
  { key: 'payBadge', statement: 'Payment status badge on every invoice', scope: ['web/src/invoices/PaymentBadge.tsx'], rests: ['pay'], state: 'claimed', cluster: 'web' },
  // immut
  { key: 'imCredit', statement: 'Credit notes for issued invoices', scope: ['src/invoices/credits.ts'], rests: ['immut'], state: 'claimed', cluster: 'billing' },
  { key: 'imLock', statement: 'Lock invoice fields once an invoice is issued', scope: ['src/invoices/lock.ts'], rests: ['immut'], state: 'claimed', cluster: 'billing' },
  { key: 'imPdf', statement: 'Render invoice PDFs', scope: ['src/pdf/**'], rests: ['immut'], state: 'landed', cluster: 'billing' },
  { key: 'imEmail', statement: 'Email the PDF when an invoice is issued', scope: ['src/email/issue.ts'], after: ['imPdf'], state: 'claimed', cluster: 'billing' },
  // pg
  { key: 'pgMigrate', statement: 'Migrations for invoices and line items', scope: ['db/migrations/**'], rests: ['pg'], state: 'landed', cluster: 'platform' },
  { key: 'pgBackup', statement: 'Nightly database backups', scope: ['ops/backup/**'], rests: ['pg'], state: 'claimed', cluster: 'platform' },
  { key: 'pgSearch', statement: 'Full-text search over invoices', scope: ['src/search/**'], rests: ['pg'], after: ['pgMigrate'], state: 'claimed', cluster: 'platform' },
  { key: 'pgReplica', statement: 'Send report queries to a read replica', scope: ['src/db/replica.ts'], rests: ['pg'], state: 'open', cluster: 'platform' },
  // cents
  { key: 'cMoney', statement: 'Money type in integer cents', scope: ['src/money/money.ts'], rests: ['cents'], state: 'landed', cluster: 'billing' },
  { key: 'cTax', statement: 'Tax per line item, rounded half-even', scope: ['src/tax/**'], rests: ['cents'], after: ['cMoney'], state: 'claimed', cluster: 'billing' },
  { key: 'cFx', statement: 'Multi-currency totals at the invoice date', scope: ['src/money/fx.ts'], rests: ['cents'], state: 'claimed', cluster: 'billing' },
  { key: 'cDiscount', statement: 'Discount codes on checkout', scope: ['src/discounts/**'], rests: ['cents'], state: 'open', cluster: 'billing' },
  // a11y
  { key: 'uiKeys', statement: 'Keyboard navigation in the invoice editor', scope: ['web/src/editor/**'], rests: ['a11y'], state: 'claimed', cluster: 'web' },
  { key: 'uiDark', statement: 'Dark theme for the whole app', scope: ['web/src/theme/**'], rests: ['a11y'], state: 'claimed', cluster: 'web' },
  { key: 'uiLabels', statement: 'Screen-reader labels on the dashboard', scope: ['web/src/dashboard/a11y.ts'], rests: ['a11y'], state: 'claimed', cluster: 'web' },
  { key: 'uiMobile', statement: 'Mobile layout for invoices', scope: ['web/src/invoices/mobile.css'], rests: ['a11y'], state: 'open', cluster: 'web' },
  // nothing declared yet
  { key: 'ci', statement: 'Continuous integration for the monorepo', scope: ['.github/workflows/**'], state: 'landed', cluster: 'platform' },
  { key: 'docs', statement: 'Write the onboarding guide for new agents', scope: ['docs/onboarding.md'], state: 'open', cluster: 'platform' },
];

const AGENTS = [
  'ada', 'basil', 'cora', 'dex', 'elio', 'fern', 'gus', 'hana', 'iris', 'jude', 'kai', 'lena', 'milo', 'nia', 'otto',
  'pia', 'quin', 'rhea', 'sol', 'tao', 'uma', 'vik', 'wren', 'xia', 'yara', 'zed', 'arlo', 'bea', 'cy', 'dot', 'eve',
];

const HEDGE = {
  finder: 'payHooks',
  statement: "The provider retires its v2 API in March; v3 changes how refunds settle",
  target: 'pay',
};
const HEADLINE = {
  finder: 'cFx',
  statement: 'The date library drops the UTC offset when it parses ISO dates across a DST change',
  target: 'tz',
};
const REPLAN = 'Dates are stored as UTC instants and converted to local time only at the edge';

// ----------------------------------------------------------------- http --

async function api(method, path, token, body) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${G}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        // A request the server never answers must not stall every agent.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt < 4) {
        await sleep(400 * attempt);
        continue;
      }
      throw err;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(400 * attempt);
      continue;
    }
    return { status: res.status, data };
  }
}

async function must(method, path, token, body) {
  const r = await api(method, path, token, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function needState() {
  const state = loadState();
  if (!state) throw new Error(`no demo state for graph "${GRAPH}" at ${STATE_FILE}; run "seed" first`);
  return state;
}

// ------------------------------------------------------------- commands --

async function seed() {
  const snap = await must('GET', '/snapshot');
  if (snap.nodes.length && !FORCE) {
    throw new Error(`graph "${GRAPH}" already has ${snap.nodes.length} nodes; use another --graph or --force`);
  }
  log(`seeding ${G}`);
  // The main line has to exist before claims can fork it.
  await must('POST', '/lines/main/access', ADMIN, { scope: 'read', ttl: 60 });

  const state = { graph: GRAPH, base: BASE, a: {}, c: {}, leases: {} };
  for (const [key, statement] of Object.entries(ASSUMPTIONS)) {
    state.a[key] = (await must('POST', '/assumptions', ADMIN, { statement })).id;
  }
  for (const c of CLAIMS) {
    const made = await must('POST', '/claims', ADMIN, {
      statement: c.statement,
      scope: c.scope,
      cluster: c.cluster,
      restsOn: (c.rests ?? []).map((k) => state.a[k]),
      requires: (c.after ?? []).map((k) => state.c[k]),
    });
    state.c[c.key] = made.id;
  }
  log(`planned ${Object.keys(state.a).length} assumptions and ${CLAIMS.length} claims`);

  // Work happens in dependency order: what others build on finishes first.
  let agent = 0;
  const take = async (c) => {
    const id = state.c[c.key];
    const name = AGENTS[agent++ % AGENTS.length];
    const g = await must('POST', `/claims/${id}/claim`, AGENT, { agent: name });
    state.leases[id] = { token: g.token, agent: name, expiresAt: g.expiresAt, total: g.expiresAt - Date.now() };
    return id;
  };
  for (const c of CLAIMS.filter((c) => c.state === 'landed')) {
    const id = await take(c);
    await must('POST', `/claims/${id}/finish`, state.leases[id].token);
    delete state.leases[id];
    // A finished claim with no commits lands by itself; mark it if not.
    const node = (await must('GET', '/snapshot')).nodes.find((n) => n.id === id);
    if (node?.status === 'done') await api('POST', `/claims/${id}/land`, ADMIN);
  }
  for (const c of CLAIMS.filter((c) => c.state === 'claimed')) await take(c);
  saveState(state);
  const n = Object.keys(state.leases).length;
  log(`${n} agents at work; ${CLAIMS.filter((c) => c.state === 'open').length} claims left open`);
  log(`watch it: ${BASE}/g/${GRAPH}`);
  return state;
}

async function fileFinding(state, spec) {
  const finder = state.c[spec.finder];
  const lease = state.leases[finder];
  if (!lease) throw new Error(`no lease held on ${finder} (${spec.finder})`);
  const r = await must('POST', '/findings', lease.token, {
    finder,
    statement: spec.statement,
    effect: 'contradicts',
    targets: [state.a[spec.target]],
  });
  log(`${lease.agent} on ${finder} filed ${r.finding.id}${r.duplicate ? ' (already filed)' : ''}: ${spec.statement}`);
  return r.finding.id;
}

async function hedge() {
  const state = needState();
  await renewAll(state);
  const fid = await fileFinding(state, HEDGE);
  state.hedge = fid;
  saveState(state);
}

async function fileHeadline(state) {
  const fid = await fileFinding(state, HEADLINE);
  state.headline = fid;
  saveState(state);
  const impact = await must('GET', `/findings/${fid}/impact`);
  log(`if verified: ${impact.affected.length} claims go stale (${impact.affected.join(', ')}), ${impact.cost} pushes at stake`);
  return fid;
}

async function verify(fid) {
  const done = await must('POST', `/findings/${fid}/verify`, ADMIN);
  log(`verified ${fid}: ${done.affected.length} claims stale; everyone else keeps working`);
}

async function scene() {
  const state = needState();
  await renewAll(state);
  const fid = await fileHeadline(state);
  log(`verifying in ${VERIFY_AFTER}s — nobody stops meanwhile`);
  await sleep(VERIFY_AFTER * 1000);
  await verify(fid);
  saveState(state);
}

// Renew every lease we hold. A stale claim's renewal tells its agent (and is
// not extended); returns the claims whose agents just learned they are stale.
async function renewAll(state, quiet = true) {
  const told = [];
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.told) continue;
    const r = await api('POST', `/claims/${id}/renew`, lease.token);
    if (r.status !== 200) {
      if (!quiet) log(`${lease.agent} lost ${id}: ${r.data?.error ?? r.status}`);
      lease.lost = true;
      continue;
    }
    if (r.data.ok === false && r.data.reason === 'stale') {
      lease.told = Date.now();
      told.push(id);
      const n = r.data.notices.find((x) => x.type === 'claim.stale');
      log(`${lease.agent} learned ${id} is stale${n ? ` (finding ${n.data.finding})` : ''} — stops and waits to re-plan`);
    } else lease.expiresAt = r.data.expiresAt;
  }
  return told;
}

async function replan(state, ids) {
  if (!state.replanAssumption) {
    state.replanAssumption = (await must('POST', '/assumptions', ADMIN, { statement: REPLAN })).id;
    log(`planner added ${state.replanAssumption}: ${REPLAN}`);
  }
  for (const id of ids) {
    let lease = state.leases[id];
    const snap = await must('GET', '/snapshot');
    const node = snap.nodes.find((n) => n.id === id);
    if (!node || node.status !== 'stale') continue;
    const live = node.lease && node.lease.expiresAt > Date.now();
    if (!lease || !live) {
      // The agent left (or the claim was done when it went stale): take it over.
      const name = lease?.agent ?? AGENTS[Math.floor(Math.random() * AGENTS.length)];
      const g = await api('POST', `/claims/${id}/claim`, AGENT, { agent: name });
      if (g.status !== 200) {
        log(`could not take ${id} to re-plan: ${g.data?.error}`);
        continue;
      }
      lease = state.leases[id] = { token: g.data.token, agent: name, expiresAt: g.data.expiresAt, total: g.data.expiresAt - Date.now() };
    }
    // Keep what still holds; swap a contradicted assumption for the new one.
    const status = new Map(snap.nodes.map((n) => [n.id, n.status]));
    const rests = snap.edges
      .filter((e) => e.target === id && e.purpose === 'required for' && snap.nodes.find((n) => n.id === e.source)?.kind === 'assumption')
      .map((e) => e.source);
    // The new assumption goes first: it is what the new plan is about.
    const restsOn = rests.filter((a) => status.get(a) === 'holding');
    if (rests.some((a) => status.get(a) === 'contradicted')) restsOn.unshift(state.replanAssumption);
    const r = await api('POST', `/claims/${id}/replan`, lease.token, { restsOn });
    if (r.status === 200) {
      delete lease.told;
      lease.expiresAt = r.data.claim.lease?.expiresAt ?? lease.expiresAt;
      log(`${lease.agent} re-planned ${id} (v${r.data.claim.version}), resting on ${restsOn.join(', ') || 'nothing declared'}`);
    } else log(`re-plan of ${id} failed: ${r.data?.error} ${r.data?.message ?? ''}`);
  }
  saveState(state);
}

// Other commands (hedge, scene, replan) may run while `live` does: adopt any
// lease they took, so their agents keep renewing too.
function adopt(state) {
  const disk = loadState();
  if (!disk) return;
  for (const [id, l] of Object.entries(disk.leases ?? {})) {
    if (!state.leases[id] || state.leases[id].token !== l.token) state.leases[id] = { ...l };
  }
  for (const k of ['replanAssumption', 'hedge', 'headline']) if (disk[k] && !state[k]) state[k] = disk[k];
}

async function live({ sceneAfter = 0 } = {}) {
  const state = needState();
  log(`keeping ${Object.keys(state.leases).length} agents at work on ${GRAPH} (Ctrl-C to stop)`);
  const started = Date.now();
  let filedAt = 0;
  let headline = null;
  // Each agent renews at its own rhythm, so the countdowns on the canvas spread out.
  const rhythm = {};
  for (;;) {
    adopt(state);
    for (const [id, lease] of Object.entries(state.leases)) {
      if (lease.told || lease.lost) continue;
      rhythm[id] ??= 0.2 + Math.random() * 0.55; // renew when this fraction of the lease is left
      const total = lease.total || 120_000;
      const left = (lease.expiresAt ?? 0) - Date.now();
      if (left > total * rhythm[id]) continue;
      const r = await api('POST', `/claims/${id}/renew`, lease.token);
      if (r.status !== 200) {
        log(`${lease.agent} lost ${id}: ${r.data?.error ?? r.status}`);
        lease.lost = true;
        continue;
      }
      if (r.data.ok === false && r.data.reason === 'stale') {
        lease.told = Date.now();
        log(`${lease.agent} learned ${id} is stale at its renewal — stops and waits to re-plan`);
      } else {
        lease.total = Math.max(lease.total ?? 0, r.data.expiresAt - Date.now());
        lease.expiresAt = r.data.expiresAt;
        rhythm[id] = 0.2 + Math.random() * 0.55;
      }
    }
    if (sceneAfter && !filedAt && Date.now() - started > sceneAfter * 1000) {
      headline = await fileHeadline(state);
      filedAt = Date.now();
      log(`verifying in ${VERIFY_AFTER}s — nobody stops meanwhile`);
    }
    if (headline && Date.now() - filedAt > VERIFY_AFTER * 1000) {
      await verify(headline);
      headline = null;
    }
    if (REPLAN_AFTER > 0) {
      const due = Object.entries(state.leases)
        .filter(([, l]) => l.told && Date.now() - l.told > REPLAN_AFTER * 1000)
        .map(([id]) => id);
      if (due.length) await replan(state, due);
    }
    adopt(state);
    saveState(state);
    await sleep(1000);
  }
}

async function main() {
  if (!ADMIN || !AGENT) throw new Error('set SUPERPOSE_ADMIN_TOKEN and SUPERPOSE_AGENT_KEY (or --admin/--agent) for a remote --base');
  switch (command) {
    case 'seed':
      await seed();
      break;
    case 'hedge':
      await hedge();
      break;
    case 'scene':
      await scene();
      break;
    case 'live':
      await live();
      break;
    case 'replan': {
      const state = needState();
      const snap = await must('GET', '/snapshot');
      const stale = snap.nodes.filter((n) => n.kind === 'claim' && n.status === 'stale').map((n) => n.id);
      await replan(state, stale);
      break;
    }
    case 'all':
      await seed();
      await sleep(4000);
      await hedge();
      await live({ sceneAfter: SCENE_AFTER });
      break;
    default:
      console.error(`unknown command "${command}"; see the top of ${fileURLToPath(import.meta.url)}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

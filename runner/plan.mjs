#!/usr/bin/env node
// Set up a project graph from a scenario directory:
//
//   node runner/plan.mjs scenarios/<name> --graph <gid>
//
// scenarios/<name>/plan.json lists the assumptions and claims:
//   { "assumptions": [{ "key": "ascii", "statement": "..." }],
//     "claims": [{ "key": "slugify", "statement": "...", "scope": ["src/slugify.js"],
//                  "restsOn": ["ascii"], "requires": ["other claim key"] }] }
// scenarios/<name>/seed/ is the starter code. It is pushed to the graph's main
// line in one commit (claims fork the line when they are taken, so it goes
// first), then the assumptions and claims are created with the admin token.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Api, REPO_DIR, UsageError, canvasUrl, explainError, git, gitAuthEnv, loadEnv, serviceUrl, shortSha } from './lib.mjs';

const USAGE = `Usage: node runner/plan.mjs <scenario dir> --graph <gid> [--url <url>] [--env <file>] [--force]

Creates the scenario's assumptions and claims in graph <gid>, after seeding
the graph's main line with the scenario's seed/ folder. Refuses a graph that
already has nodes unless --force. Needs SUPERPOSE_ADMIN_TOKEN.`;

const OPTIONS = {
  graph: { type: 'string' },
  url: { type: 'string' },
  env: { type: 'string' },
  force: { type: 'boolean' },
  runs: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function readPlan(dir) {
  const file = join(dir, 'plan.json');
  if (!existsSync(file)) throw new UsageError(`${file} not found`);
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const assumptions = plan.assumptions ?? [];
  const claims = plan.claims ?? [];
  const aKeys = new Set();
  for (const a of assumptions) {
    if (!a.key || !a.statement) throw new UsageError(`every assumption needs a key and a statement: ${JSON.stringify(a)}`);
    if (aKeys.has(a.key)) throw new UsageError(`assumption key "${a.key}" is used twice`);
    aKeys.add(a.key);
  }
  const cKeys = new Set(claims.map((c) => c.key));
  if (cKeys.size !== claims.length) throw new UsageError('claim keys must be unique');
  for (const c of claims) {
    if (!c.key || !c.statement || !Array.isArray(c.scope) || !c.scope.length) {
      throw new UsageError(`every claim needs a key, a statement and a scope: ${JSON.stringify(c)}`);
    }
    for (const k of c.restsOn ?? []) if (!aKeys.has(k)) throw new UsageError(`claim "${c.key}" rests on unknown assumption "${k}"`);
    for (const k of c.requires ?? []) if (!cKeys.has(k)) throw new UsageError(`claim "${c.key}" requires unknown claim "${k}"`);
  }
  return { name: plan.name ?? basename(dir), assumptions, claims: inDependencyOrder(claims) };
}

// Claims are created after the claims they require (the API checks they exist).
function inDependencyOrder(claims) {
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const out = [];
  const state = new Map();
  const visit = (c, path) => {
    if (state.get(c.key) === 'done') return;
    if (state.get(c.key) === 'visiting') throw new UsageError(`claims require each other in a cycle: ${[...path, c.key].join(' -> ')}`);
    state.set(c.key, 'visiting');
    for (const k of c.requires ?? []) visit(byKey.get(k), [...path, c.key]);
    state.set(c.key, 'done');
    out.push(c);
  };
  for (const c of claims) visit(c, []);
  return out;
}

// One commit with the seed folder, pushed to the line's main branch.
async function seedLine(api, admin, seedDir, scenario) {
  const access = await api.lineAccess(admin, 'main', 'write', 600);
  if (!access.ok) throw new Error(`could not get write access to the line: ${explainError(access)}`);
  const { remote, token, repo } = access.data;
  const tmp = mkdtempSync(join(tmpdir(), 'superpose-seed-'));
  try {
    git(tmp, ['init', '--quiet', '-b', 'main']);
    cpSync(seedDir, tmp, { recursive: true });
    git(tmp, ['add', '-A']);
    const identity = git(tmp, ['config', 'user.email'], { check: false }).stdout.trim()
      ? []
      : ['-c', 'user.name=Superpose planner', '-c', 'user.email=planner@superpose.invalid'];
    git(tmp, [...identity, 'commit', '--quiet', '-m', `Start the ${scenario} project`]);
    const sha = git(tmp, ['rev-parse', 'HEAD']).stdout.trim();
    const files = git(tmp, ['ls-files']).stdout.split('\n').filter(Boolean).length;
    const push = git(tmp, ['push', '--quiet', remote, 'HEAD:refs/heads/main'], { env: gitAuthEnv(token), check: false });
    if (push.code !== 0) {
      throw new Error(`could not push the seed to ${repo} (is the line already seeded?): ${push.stderr.trim().split('\n').at(-1)}`);
    }
    return { repo, sha, files };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  try {
    loadEnv(values.env);
    const scenarioDir = positionals[0] ? resolve(positionals[0]) : null;
    if (!scenarioDir) throw new UsageError('Give the scenario directory, e.g. scenarios/tiny.');
    const graph = values.graph;
    if (!graph || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(graph)) throw new UsageError('--graph <gid> is required (letters, digits, - and _).');
    const admin = process.env.SUPERPOSE_ADMIN_TOKEN;
    if (!admin) throw new UsageError('SUPERPOSE_ADMIN_TOKEN is not set: export it, or pass --env <file> that defines it.');
    const plan = readPlan(scenarioDir);
    const url = serviceUrl(values.url);
    const api = new Api(url, graph);

    const snap = await api.snapshot();
    if (!snap.ok) throw new Error(`could not read graph ${graph}: ${explainError(snap)}`);
    if (snap.data.nodes.length && !values.force) {
      throw new UsageError(`Graph ${graph} already has ${snap.data.nodes.length} nodes. Pick a new graph id, or pass --force to add to it.`);
    }

    const seedDir = join(scenarioDir, 'seed');
    if (existsSync(seedDir)) {
      const seeded = await seedLine(api, admin, seedDir, plan.name);
      console.log(`Seeded the main line (${seeded.repo}) with ${seeded.files} files at ${shortSha(seeded.sha)}.`);
    } else {
      console.log('No seed/ folder: the main line starts empty.');
    }

    const ids = { assumptions: {}, claims: {} };
    for (const a of plan.assumptions) {
      const res = await api.addAssumption(admin, a.statement);
      if (!res.ok) throw new Error(`could not create assumption "${a.key}": ${explainError(res)}`);
      ids.assumptions[a.key] = res.data.id;
      console.log(`  assumption ${res.data.id.padEnd(4)} ${a.key}: ${a.statement}`);
    }
    for (const c of plan.claims) {
      const res = await api.addClaim(admin, {
        statement: c.statement,
        scope: c.scope,
        restsOn: (c.restsOn ?? []).map((k) => ids.assumptions[k]),
        requires: (c.requires ?? []).map((k) => ids.claims[k]),
        ...(c.line ? { line: c.line } : {}),
      });
      if (!res.ok) throw new Error(`could not create claim "${c.key}": ${explainError(res)}`);
      ids.claims[c.key] = res.data.id;
      const deps = [...(c.restsOn ?? []).map((k) => ids.assumptions[k]), ...(c.requires ?? []).map((k) => ids.claims[k])];
      console.log(`  claim      ${res.data.id.padEnd(4)} ${c.key}: scope ${c.scope.join(', ')}${deps.length ? `; rests on ${deps.join(', ')}` : ''}`);
    }
    const runsDir = join(resolve(values.runs ?? join(REPO_DIR, 'runs')), graph);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'plan-ids.json'), JSON.stringify({ graph, url, scenario: plan.name, ...ids }, null, 2) + '\n');
    console.log(`\nGraph ${graph} is ready: ${plan.assumptions.length} assumptions, ${plan.claims.length} claims.`);
    console.log(`Canvas: ${canvasUrl(url, graph)}`);
    console.log(`Start agents: node runner/run.mjs --graph ${graph} --agents 3`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`plan failed: ${err?.message ?? err}\n`);
    return 1;
  }
}

process.exitCode = await main();

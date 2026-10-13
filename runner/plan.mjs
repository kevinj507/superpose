#!/usr/bin/env node
// Set up a project graph from a scenario directory:
//
//   node runner/plan.mjs scenarios/<name> --graph <gid>
//
// scenarios/<name>/plan.json lists the assumptions and claims, and optionally
// more lines (one decision built two ways):
//   { "constitution": [{ "key": "see-is-pay", "statement": "...", "check": "node --test constitution/see-is-pay.test.js" }],
//     "assumptions": [{ "key": "ascii", "statement": "..." }],
//     "lines": [{ "name": "fast", "from": "main", "decision": "storage", "option": "in memory" }],
//     "claims": [{ "key": "slugify", "statement": "...", "scope": ["src/slugify.js"],
//                  "restsOn": ["ascii"], "requires": ["other claim key"], "line": "fast" }] }
// scenarios/<name>/seed/ is the starter code. It is pushed to the graph's main
// line in one commit (claims fork their line when they are taken, so it goes
// first); then the other lines are forked from it, and the assumptions and
// claims are created with the admin token. A claim without "line" builds on main.
// A line entry without "from" (main, say) only labels that line with its
// decision and option; "overlay": "<folder>" pushes that folder's files on top
// of a newly forked line, so the two options start from different code.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Api, REPO_DIR, UsageError, canvasUrl, explainError, git, gitAuthEnv, loadEnv, servedUrl, serviceUrl, shortSha } from './lib.mjs';

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
  const constitution = plan.constitution ?? [];
  const claims = plan.claims ?? [];
  for (const a of constitution) {
    if (typeof a.key !== 'string' || !a.key || typeof a.statement !== 'string' || !a.statement.trim()) {
      throw new UsageError('every article of the constitution needs a "key" and a "statement"');
    }
    if (a.check !== undefined && (typeof a.check !== 'string' || !a.check.trim())) throw new UsageError(`article "${a.key}": "check" must be a command`);
  }
  const aKeys = new Set();
  for (const a of assumptions) {
    if (!a.key || !a.statement) throw new UsageError(`every assumption needs a key and a statement: ${JSON.stringify(a)}`);
    if (aKeys.has(a.key)) throw new UsageError(`assumption key "${a.key}" is used twice`);
    aKeys.add(a.key);
  }
  // A line with "from" is forked from that line (listed before it); one
  // without "from" (main, say) only gets its decision and option labels.
  const lines = plan.lines ?? [];
  const lineNames = new Set(['main']);
  for (const l of lines) {
    if (!l.name || !/^[A-Za-z0-9_-]{1,64}$/.test(l.name)) throw new UsageError(`every line needs a name of letters, digits, - and _: ${JSON.stringify(l)}`);
    if (l.from) {
      if (lineNames.has(l.name)) throw new UsageError(`line "${l.name}" is created twice (main always exists)`);
      if (!lineNames.has(l.from)) throw new UsageError(`line "${l.name}" is forked from "${l.from}", which is not listed before it`);
      lineNames.add(l.name);
    } else if (!lineNames.has(l.name)) {
      throw new UsageError(`line "${l.name}" has no "from", so it must be main or a line listed before it`);
    }
    if (l.overlay) {
      if (!l.from) throw new UsageError(`line "${l.name}": an overlay goes on a new line, so give it a "from"`);
      if (!existsSync(join(dir, l.overlay))) throw new UsageError(`line "${l.name}": overlay folder ${join(dir, l.overlay)} not found`);
    }
  }
  const cKeys = new Set(claims.map((c) => c.key));
  if (cKeys.size !== claims.length) throw new UsageError('claim keys must be unique');
  for (const c of claims) {
    if (!c.key || !c.statement || !Array.isArray(c.scope) || !c.scope.length) {
      throw new UsageError(`every claim needs a key, a statement and a scope: ${JSON.stringify(c)}`);
    }
    for (const k of c.restsOn ?? []) if (!aKeys.has(k)) throw new UsageError(`claim "${c.key}" rests on unknown assumption "${k}"`);
    for (const k of c.requires ?? []) if (!cKeys.has(k)) throw new UsageError(`claim "${c.key}" requires unknown claim "${k}"`);
    if (c.line && !lineNames.has(c.line)) throw new UsageError(`claim "${c.key}" builds on unknown line "${c.line}"`);
  }
  return { name: plan.name ?? basename(dir), assumptions, constitution, lines, claims: inDependencyOrder(claims) };
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

// One commit with a folder's files, pushed to a line's main branch: the seed
// of a new line, or (onTop) an overlay on a line that already has commits.
async function pushFolder(api, admin, line, folder, message, onTop = false) {
  const access = await api.lineAccess(admin, line, 'write', 600);
  if (!access.ok) throw new Error(`could not get write access to line ${line}: ${explainError(access)}`);
  const { remote, token, repo } = access.data;
  const env = gitAuthEnv(token);
  const tmp = mkdtempSync(join(tmpdir(), 'superpose-seed-'));
  try {
    if (onTop) {
      rmSync(tmp, { recursive: true, force: true });
      const clone = git(tmpdir(), ['clone', '--quiet', remote, tmp], { env, check: false });
      if (clone.code !== 0) throw new Error(`could not clone ${repo}: ${clone.stderr.trim().split('\n').at(-1)}`);
    } else {
      git(tmp, ['init', '--quiet', '-b', 'main']);
    }
    cpSync(folder, tmp, { recursive: true, force: true });
    git(tmp, ['add', '-A']);
    const identity = git(tmp, ['config', 'user.email'], { check: false }).stdout.trim()
      ? []
      : ['-c', 'user.name=Superpose planner', '-c', 'user.email=planner@superpose.invalid'];
    git(tmp, [...identity, 'commit', '--quiet', '-m', message]);
    const sha = git(tmp, ['rev-parse', 'HEAD']).stdout.trim();
    const files = onTop
      ? git(tmp, ['diff', '--name-only', 'HEAD~1', 'HEAD']).stdout.split('\n').filter(Boolean).length
      : git(tmp, ['ls-files']).stdout.split('\n').filter(Boolean).length;
    const push = git(tmp, ['push', '--quiet', remote, 'HEAD:refs/heads/main'], { env, check: false });
    if (push.code !== 0) {
      const hint = onTop ? '' : ' (is the line already seeded?)';
      throw new Error(`could not push to ${repo}${hint}: ${push.stderr.trim().split('\n').at(-1)}`);
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
      const seeded = await pushFolder(api, admin, 'main', seedDir, `Start the ${plan.name} project`);
      console.log(`Seeded the main line (${seeded.repo}) with ${seeded.files} files at ${shortSha(seeded.sha)}.`);
    } else {
      console.log('No seed/ folder: the main line starts empty.');
    }

    for (const l of plan.lines) {
      const labels = { ...(l.decision ? { decision: l.decision } : {}), ...(l.option ? { option: l.option } : {}) };
      const what = [l.decision && `decision “${l.decision}”`, l.option && `option “${l.option}”`].filter(Boolean).join(', ');
      if (!l.from) {
        const res = await api.createLine(admin, l.name, labels);
        if (!res.ok) throw new Error(`could not label line "${l.name}": ${explainError(res)}`);
        console.log(`  line       ${l.name}: ${what || 'no labels'}`);
        continue;
      }
      const res = await api.createLine(admin, l.name, { from: l.from, ...labels });
      if (!res.ok) throw new Error(`could not create line "${l.name}": ${explainError(res)}`);
      let overlaid = '';
      if (l.overlay) {
        const pushed = await pushFolder(api, admin, l.name, join(scenarioDir, l.overlay), `Build the ${l.name} line: ${l.option ?? l.overlay}`, true);
        overlaid = `, with ${l.overlay}/ on top (${pushed.files} files, ${shortSha(pushed.sha)})`;
      }
      console.log(`  line       ${l.name}: forked from ${l.from}${what ? ` (${what})` : ''}${overlaid}`);
    }

    const ids = { assumptions: {}, constitution: {}, claims: {} };
    // The constitution first: what the product keeps whatever is built, each
    // article with its check (a command at the repo root) or judged without one.
    for (const a of plan.constitution) {
      const res = await api.addAssumption(admin, a.statement, { constitution: true, ...(a.check ? { check: a.check } : {}) });
      if (!res.ok) throw new Error(`could not create article "${a.key}": ${explainError(res)}`);
      ids.constitution[a.key] = res.data.id;
      console.log(`  article    ${res.data.id.padEnd(4)} ${a.key}: ${a.statement}${a.check ? ` [${a.check}]` : ' [judged]'}`);
    }
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
      const rests = (c.restsOn ?? []).map((k) => ids.assumptions[k]);
      const builds = (c.requires ?? []).map((k) => ids.claims[k]);
      console.log(
        `  claim      ${res.data.id.padEnd(4)} ${c.key}: scope ${c.scope.join(', ')}` +
          (rests.length ? `; rests on ${rests.join(', ')}` : '') +
          (builds.length ? `; builds on ${builds.join(', ')}` : '') +
          (c.line && c.line !== 'main' ? `; line ${c.line}` : ''),
      );
    }
    const runsDir = join(resolve(values.runs ?? join(REPO_DIR, 'runs')), graph);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'plan-ids.json'), JSON.stringify({ graph, url, scenario: plan.name, ...ids }, null, 2) + '\n');
    const lineCount = new Set(['main', ...plan.lines.map((l) => l.name)]).size;
    console.log(
      `\nGraph ${graph} is ready: ${plan.constitution.length ? `a constitution of ${plan.constitution.length} articles, ` : ''}${plan.assumptions.length} assumptions, ${plan.claims.length} claims` +
        `${lineCount > 1 ? `, ${lineCount} lines` : ''}.`,
    );
    console.log(`Canvas: ${canvasUrl(url, graph)}`);
    console.log(`Served: ${servedUrl(url, graph)}`);
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

#!/usr/bin/env node
// The end of an experiment run with Superpose: check out what a line holds
// now, run the project's visible tests and a hidden check on it, and record
// what happened on the graph (claims, findings, notices, spend). The plain-git
// arm's runner does the same for its main branch (runner/plain.mjs).
//
//   node runner/final-check.mjs --graph <gid> [--line main] --hidden <path/to/check.mjs> [--out <file.json>]
// Needs SUPERPOSE_ADMIN_TOKEN (and SUPERPOSE_URL unless the hosted one).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Api, serviceUrl } from './lib.mjs';

const { values } = parseArgs({
  options: { graph: { type: 'string' }, line: { type: 'string', default: 'main' }, hidden: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' } },
});
const admin = process.env.SUPERPOSE_ADMIN_TOKEN;
if (!values.graph || !admin) {
  console.error('usage: SUPERPOSE_ADMIN_TOKEN=... node runner/final-check.mjs --graph <gid> [--line main] --hidden <check.mjs> [--out <file>]');
  process.exit(2);
}
const api = new Api(serviceUrl(values.url), values.graph);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });

const access = await api.lineAccess(admin, values.line, 'read', 600);
if (!access.ok) throw new Error(`no read access to line ${values.line}: ${JSON.stringify(access.data)}`);
const dir = mkdtempSync(join(tmpdir(), 'sp-final-'));
const result = { graph: values.graph, line: values.line, at: new Date().toISOString() };
try {
  const clone = run('git', ['-c', `http.extraHeader=Authorization: Bearer ${access.data.token}`, 'clone', '-q', access.data.remote, join(dir, 'repo')], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr.trim()}`);
  const repo = join(dir, 'repo');
  result.head = run('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
  const install = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: repo });
  const visible = run('npm', ['test'], { cwd: repo });
  result.visible = { pass: install.status === 0 && visible.status === 0, tail: (visible.stdout + visible.stderr).trim().split('\n').slice(-15).join('\n') };
  if (values.hidden) {
    const hidden = run(process.execPath, [values.hidden, repo]);
    const lastLine = hidden.stdout.trim().split('\n').pop() ?? '';
    try {
      result.hidden = JSON.parse(lastLine);
    } catch {
      result.hidden = { hidden: 'error', detail: (hidden.stdout + hidden.stderr).trim().slice(-2000) };
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// What happened on the graph.
const snap = await api.snapshot();
if (snap.ok) {
  const nodes = snap.data.nodes;
  const count = (items, key) => items.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] ?? 0) + 1 }), {});
  const claims = nodes.filter((n) => n.kind === 'claim');
  const findings = nodes.filter((n) => n.kind === 'finding');
  result.claims = count(claims, 'status');
  result.assumptions = nodes.filter((n) => n.kind === 'assumption').map((a) => ({ id: a.id, status: a.status, statement: a.statement }));
  result.findings = findings.map((f) => ({ id: f.id, effect: f.effect, status: f.status, targets: f.targets, finder: f.finder, statement: f.statement }));
  result.events = count(snap.data.events, 'type');
  result.spend = claims.map((c) => ({ id: c.id, spend: c.spend ?? null }));
}
const text = JSON.stringify(result, null, 2);
if (values.out) writeFileSync(values.out, text + '\n');
console.log(text);

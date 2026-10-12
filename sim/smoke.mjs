#!/usr/bin/env node
// End-to-end smoke test against a deployed Superpose: seed a line with a tiny
// tested project, claim work, push with plain git, wait for the checks on the
// exact commit, finish, wait for the landing (a real merge with the checks
// re-run), and confirm the claim built on it forks from code that contains it.
//
//   SUPERPOSE_ADMIN_TOKEN=... SUPERPOSE_AGENT_KEY=... node sim/smoke.mjs
//
// Deletes its repos at the end when CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID are set.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.SUPERPOSE_URL ?? 'https://superpose.kevinj507.workers.dev';
const ADMIN = process.env.SUPERPOSE_ADMIN_TOKEN;
const AGENT = process.env.SUPERPOSE_AGENT_KEY;
if (!ADMIN || !AGENT) throw new Error('set SUPERPOSE_ADMIN_TOKEN and SUPERPOSE_AGENT_KEY');
const GRAPH = `smoke-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`, ...a);
const failures = [];
const expect = (ok, what) => {
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) failures.push(what);
};

async function api(method, path, token, body) {
  const res = await fetch(`${URL_}/api/graphs/${GRAPH}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Superpose smoke', '-c', 'user.email=smoke@superpose.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const auth = (token) => `http.extraHeader=Authorization: Bearer ${token}`;
async function until(what, fn, seconds = 180) {
  for (let waited = 0; waited < seconds; waited += 5) {
    const v = await fn();
    if (v) return v;
    await sleep(5000);
  }
  return null;
}
const work = mkdtempSync(join(tmpdir(), 'sp-smoke-'));

try {
  // A line with a tiny project whose tests can pass or fail.
  const seed = (await api('POST', '/lines/main/access', ADMIN, { scope: 'write', ttl: 900 })).data;
  const seedDir = join(work, 'seed');
  mkdirSync(join(seedDir, 'src'), { recursive: true });
  git(seedDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(seedDir, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(seedDir, 'src/add.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(seedDir, 'src/add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './add.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-qm', 'seed');
  git(seedDir, '-c', auth(seed.token), 'push', '-q', seed.remote, 'main');
  log(`graph ${GRAPH} seeded`);

  const a = (await api('POST', '/claims', ADMIN, { statement: 'Add multiply', scope: ['src/mul*'] })).data;
  const b = (await api('POST', '/claims', ADMIN, { statement: 'Add square, built on multiply', scope: ['src/square*'], requires: [a.id] })).data;
  expect(JSON.stringify((await api('GET', '/ready')).data.map((c) => c.id)) === JSON.stringify([a.id]), 'only the first claim is ready');

  const grant = (await api('POST', `/claims/${a.id}/claim`, AGENT, { agent: 'smoke-agent' })).data;
  expect(!!grant.git?.token && grant.git.expiresAt <= grant.expiresAt, 'claiming gives a repo and a git token that ends with the lease');
  const dir = join(work, 'a');
  git(work, '-c', auth(grant.git.token), 'clone', '-q', grant.repo.remote, dir);
  writeFileSync(join(dir, 'src/mul.js'), 'export const mul = (a, b) => a * b;\n');
  writeFileSync(join(dir, 'src/mul.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { mul } from './mul.js';\ntest('mul', () => assert.equal(mul(3, 4), 12));\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `Add multiply\n\nSuperpose-Claim: ${a.id}`);
  git(dir, '-c', auth(grant.git.token), 'push', '-q', 'origin', 'main');
  const sha = git(dir, 'rev-parse', 'HEAD');
  log(`pushed ${sha.slice(0, 8)} with plain git`);

  const checked = await until('checks', async () => {
    const row = (await api('GET', '/snapshot')).data.pushes.find((r) => r.sha === sha);
    return row?.checks && row.checks.status !== 'running' ? row : null;
  });
  expect(checked?.verdict === 'checks-passed', `tests ran on the exact commit in a container: ${checked?.verdict}`);

  await api('POST', `/claims/${a.id}/finish`, grant.token);
  let pushedAfter = true;
  try {
    git(dir, 'commit', '--allow-empty', '-qm', 'after finishing');
    git(dir, '-c', auth(grant.git.token), 'push', '-q', 'origin', 'main');
  } catch {
    pushedAfter = false;
  }
  expect(!pushedAfter, 'finishing revoked the git token');

  const landed = await until('landing', async () => {
    const n = (await api('GET', '/snapshot')).data.nodes.find((x) => x.id === a.id);
    return n?.status === 'landed' || n?.landing?.status === 'conflict' || n?.landing?.status === 'failed' ? n : null;
  });
  expect(landed?.status === 'landed', `landed by a real merge: ${landed?.landedSha?.slice(0, 8) ?? landed?.landing?.status}`);

  const ready = (await api('GET', '/ready')).data.map((c) => c.id);
  expect(ready.includes(b.id), 'the claim built on it is now ready');
  const gb = (await api('POST', `/claims/${b.id}/claim`, AGENT, { agent: 'smoke-agent-2' })).data;
  const dirB = join(work, 'b');
  git(work, '-c', auth(gb.git.token), 'clone', '-q', gb.repo.remote, dirB);
  expect(existsSync(join(dirB, 'src/mul.js')), 'its fork already contains the landed work');
  await api('POST', `/claims/${b.id}/release`, gb.token);

  const re = await api('POST', `/claims/${a.id}/recheck`, ADMIN);
  expect(re.status === 200, 'checks can be run again on request');
} finally {
  rmSync(work, { recursive: true, force: true });
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    const snap = (await api('GET', '/snapshot')).data;
    const names = [`${GRAPH}.line.main`, ...(snap?.nodes ?? []).filter((n) => n.repo).map((n) => n.repo.name)];
    const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/superpose/repos`;
    await Promise.all(names.map((n) => fetch(`${base}/${n}`, { method: 'DELETE', headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })));
    log(`deleted ${names.length} repos`);
  }
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);

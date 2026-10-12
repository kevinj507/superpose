#!/usr/bin/env node
// Checks the shop scenario itself, not Superpose: with the reference work on
// top of the seed, are the visible tests green, and does the hidden check
// catch exactly the combination that is broken?
//
//   node scenarios/shop/reference/validate.mjs
//
// It builds temporary copies of seed/ with reference work on top:
//
//   seed           nothing on top                                   hidden: pass
//   caching only   naive/'s files for the cache and fast-pages claims   pass
//   pricing only   naive/'s files for dynamic-pricing and buying-moves-price   pass
//   naive          naive/: all six claims, the page cache as asked      fail
//   integrated     integrated/: all six, and pages show the current price   pass
//   no handle      the seed with an app.js that exports no handle()     error
//
// and requires `npm test` to pass on each (but the last), and
// hidden/check.mjs to give the verdict above with its exit code. It also
// checks the plan: the claims' scopes are disjoint, src/app.js and
// src/render.js belong to no claim, and each overlay holds exactly the files
// of the claims' scopes, so all six claims are done, neither group of work
// touches the other's files, and git merges them cleanly.
//
// test/shop-scenario.test.mjs runs the same checks under vitest, with
// { quick: true }: no npm test on the two one-group copies, whose tests the
// naive and integrated copies run as well.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO = dirname(HERE);
const SEED = join(SCENARIO, 'seed');
const CHECK = join(SCENARIO, 'hidden', 'check.mjs');
const OVERLAYS = ['naive', 'integrated'];
const UNOWNED = ['src/app.js', 'src/render.js']; // the hidden test's interface
const EXIT = { pass: 0, fail: 1, error: 2 };

const CACHING = ['cache', 'fast-pages'];
const PRICING = ['dynamic-pricing', 'buying-moves-price'];

export const VARIANTS = [
  { name: 'seed', layers: [], hidden: 'pass' },
  { name: 'caching only', layers: [{ overlay: 'naive', claims: CACHING }], hidden: 'pass', oneGroup: true },
  { name: 'pricing only', layers: [{ overlay: 'naive', claims: PRICING }], hidden: 'pass', oneGroup: true },
  { name: 'naive', layers: [{ overlay: 'naive' }], hidden: 'fail' },
  { name: 'integrated', layers: [{ overlay: 'integrated' }], hidden: 'pass' },
  { name: 'no handle', layers: [], replace: { 'src/app.js': 'export const nothing = true;\n' }, visible: false, hidden: 'error' },
];

function readPlan() {
  return JSON.parse(readFileSync(join(SCENARIO, 'plan.json'), 'utf8'));
}

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)))
    .sort();
}

// The plan's promises about scopes, and the overlays against them. Scopes in
// this plan are plain file paths, so they are compared as such.
export function checkPlan(plan = readPlan()) {
  const problems = [];
  const owner = new Map();
  for (const c of plan.claims) {
    for (const path of c.scope) {
      if (/[*?[\]{}]/.test(path)) problems.push(`claim ${c.key}: scope ${path} is a pattern; this check expects plain paths`);
      if (owner.has(path)) problems.push(`${path} is in the scope of both ${owner.get(path)} and ${c.key}`);
      owner.set(path, c.key);
    }
  }
  for (const path of UNOWNED) {
    if (owner.has(path)) problems.push(`${path} must belong to no claim (the hidden test relies on it), but ${owner.get(path)} has it`);
    if (!existsSync(join(SEED, path))) problems.push(`the seed has no ${path}`);
  }
  const scoped = [...owner.keys()].sort();
  for (const overlay of OVERLAYS) {
    const files = filesUnder(join(HERE, overlay));
    for (const f of files) if (!owner.has(f)) problems.push(`${overlay}/${f} is outside every claim's scope`);
    for (const f of scoped) if (!files.includes(f)) problems.push(`${overlay}/ has no ${f}, so claim ${owner.get(f)} is not done there`);
  }
  const integratedDiffers = scoped.filter((f) => {
    const [a, b] = OVERLAYS.map((o) => join(HERE, o, f));
    return existsSync(a) && existsSync(b) && readFileSync(a, 'utf8') !== readFileSync(b, 'utf8');
  });
  return { problems, claims: plan.claims.length, scoped: scoped.length, integratedDiffers };
}

function copyLayer(layer, dir, plan) {
  const from = join(HERE, layer.overlay);
  const wanted = layer.claims ? new Set(plan.claims.filter((c) => layer.claims.includes(c.key)).flatMap((c) => c.scope)) : null;
  if (layer.claims && layer.claims.some((k) => !plan.claims.find((c) => c.key === k))) {
    throw new Error(`unknown claim in ${layer.claims.join(', ')}`);
  }
  for (const f of filesUnder(from)) if (!wanted || wanted.has(f)) cpSync(join(from, f), join(dir, f));
}

function run(command, args, cwd) {
  const env = { ...process.env, npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1' };
  delete env.NODE_TEST_CONTEXT; // started from inside a test run, the child still runs a test run of its own
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: null, out, err: `${err}${e.message}` }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function npmTest(dir) {
  const r = await run('npm', ['test'], dir);
  const count = (label) => Number(r.out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] ?? NaN);
  const failing = [...r.out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { ok: r.code === 0, code: r.code, tests: count('tests'), pass: count('pass'), fail: count('fail'), failing, tail: `${r.out}${r.err}`.slice(-1500) };
}

async function hiddenCheck(dir) {
  const r = await run(process.execPath, [CHECK, dir], dir);
  const last = r.out.trim().split('\n').at(-1) ?? '';
  try {
    const { hidden, detail } = JSON.parse(last);
    return { verdict: hidden, detail, code: r.code };
  } catch {
    return { verdict: 'unreadable', detail: `${r.out}${r.err}`.slice(-600), code: r.code };
  }
}

async function runVariant(v, plan, quick) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-validate-'));
  try {
    cpSync(SEED, dir, { recursive: true });
    for (const layer of v.layers) copyLayer(layer, dir, plan);
    for (const [path, text] of Object.entries(v.replace ?? {})) writeFileSync(join(dir, path), text);
    const skipVisible = v.visible === false || (quick && v.oneGroup);
    const [visible, hidden] = await Promise.all([skipVisible ? null : npmTest(dir), hiddenCheck(dir)]);
    const ok = (visible === null || visible.ok) && hidden.verdict === v.hidden && hidden.code === EXIT[v.hidden];
    return { name: v.name, expected: v.hidden, visible, hidden, ok };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function validateShopScenario({ quick = false } = {}) {
  const plan = readPlan();
  const scopes = checkPlan(plan);
  const variants = await Promise.all(VARIANTS.map((v) => runVariant(v, plan, quick)));
  return { scopes, variants, ok: scopes.problems.length === 0 && variants.every((v) => v.ok) };
}

function print(report) {
  const out = ['The shop scenario, built from the seed and the reference work:', ''];
  for (const v of report.variants) {
    const visible = v.visible === null ? 'npm test: not run' : `npm test: ${v.visible.ok ? 'pass' : 'FAIL'} (${v.visible.pass}/${v.visible.tests})`;
    const mark = v.ok ? 'ok ' : 'BAD';
    out.push(`${mark} ${v.name.padEnd(13)} ${visible.padEnd(26)} hidden: ${v.hidden.verdict} (exit ${v.hidden.code}), expected ${v.expected}`);
    out.push(`      ${v.hidden.detail}`);
    if (v.visible && !v.visible.ok) out.push(`      failing: ${v.visible.failing.join('; ') || v.visible.tail}`);
  }
  const s = report.scopes;
  out.push('');
  out.push(
    s.problems.length
      ? `BAD plan: ${s.problems.join('; ')}`
      : `ok  plan: ${s.claims} claims own ${s.scoped} files, no file twice; ${UNOWNED.join(' and ')} belong to no claim; ` +
          `naive/ and integrated/ each hold exactly those files; integrated/ differs from naive/ in ${s.integratedDiffers.join(', ')}`,
  );
  out.push('', report.ok ? 'Everything as expected.' : 'NOT as expected.');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  const report = await validateShopScenario();
  console.log(`${print(report)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exitCode = report.ok ? 0 : 1;
}

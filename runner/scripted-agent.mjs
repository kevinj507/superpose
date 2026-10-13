#!/usr/bin/env node
// A deterministic stand-in for a coding agent, for fast tests of the runner
// and the platform. Run by `run.mjs --agent scripted` inside a claim's working
// copy, it does what a real agent's work looks like from the outside: edits a
// file inside the claim's scope, commits (the commit hook adds the trailer),
// pushes, optionally holds the claim for a while, and finishes with
// `superpose done`.
//
// If the claim goes stale while it holds it, it tries one more push (which the
// pre-push hook refuses), declares a new assumption, re-plans resting on it,
// pushes again, and finishes.
//
// Environment:
//   SUPERPOSE_SCRIPTED_HOLD   seconds to hold the claim after the first push (default 0)
//   SUPERPOSE_SCRIPTED_STRAY  a path outside the scope (or 1 for STRAY-<claim>.txt): also push
//                             a change to it with the local hook bypassed, then take it
//                             back, so the platform's own scope check can be seen (and,
//                             if the path is in another claim's scope, its scope.touched)
//   SUPERPOSE_SCRIPTED_FINDINGS  JSON list of {when, contradicts, statement}: a claim whose
//                             statement contains `when` files a finding against the assumption
//                             it rests on whose statement contains `contradicts`, the way a
//                             real agent reports what it discovered (used by the playground);
//                             or {when, helps, statement}: it files advice for the claim whose
//                             statement contains `helps`

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI, git, hasMarker, inScope, readClaim, readMarker, shortSha, sleep } from './lib.mjs';

const dir = process.cwd();
const claim = readClaim(dir);
const hold = Number(process.env.SUPERPOSE_SCRIPTED_HOLD ?? 0) || 0;
const say = (text) => console.log(text);

function superpose(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

// A file inside the scope: a literal path if there is one, otherwise a new
// file in the first folder pattern.
function targetFile(scope, id) {
  const literal = scope.find((p) => !p.includes('*'));
  if (literal) return literal;
  const folder = scope.find((p) => p.endsWith('/**'));
  if (folder) return `${folder.slice(0, -3)}/scripted-${id}.txt`;
  return scope[0].replace(/\*\*\/?/g, '').replace(/\*/g, `scripted-${id}`);
}

function edit(file, note) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  let line = `${note}\n`;
  if (/\.(c|m)?(js|ts)$/.test(file)) line = `// ${note}\n`;
  else if (/\.(py|sh|rb|ya?ml|toml)$/.test(file)) line = `# ${note}\n`;
  else if (/\.md$/.test(file)) line = `<!-- ${note} -->\n`;
  appendFileSync(join(dir, file), line);
}

function commit(file, message) {
  git(dir, ['add', '--', file]);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function push(extra = []) {
  return git(dir, ['push', ...extra, 'origin', 'HEAD:refs/heads/main'], { check: false });
}

// Declare a new assumption and re-plan: the claim then rests on it and on
// whatever it rested on that still holds.
function replan() {
  const declared = superpose(['assume', `Scripted re-plan for ${claim.claim}: the work no longer depends on what was contradicted`, '--json']);
  if (declared.code !== 0) {
    say(`Could not declare the new assumption:\n${declared.out}`);
    return false;
  }
  const plan = superpose(['replan']);
  say(plan.out);
  return plan.code === 0;
}

if (hasMarker(dir, 'STALE')) {
  say(`Taking over a stale claim: ${(readMarker(dir, 'STALE') ?? '').trim()}`);
  if (!replan()) {
    process.exit(1);
  }
}

const file = targetFile(claim.scope, claim.claim);
say(`Working on ${claim.claim}: ${claim.statement}`);
say(`Editing ${file} (inside the scope ${claim.scope.join(', ')})`);
edit(file, `${claim.agent} worked on ${claim.claim} at ${new Date().toISOString()}`);
const first = commit(file, `Work on ${claim.claim}`);
let r = push();
say(r.code === 0 ? `Pushed ${shortSha(first)}` : `Push of ${shortSha(first)} failed:\n${r.stderr.trim()}`);

const strayEnv = process.env.SUPERPOSE_SCRIPTED_STRAY;
if (strayEnv) {
  const stray = strayEnv === '1' ? `STRAY-${claim.claim}.txt` : strayEnv;
  if (!inScope(stray, claim.scope)) {
    const existed = !!claim.baseSha && git(dir, ['cat-file', '-e', `${claim.baseSha}:${stray}`], { check: false }).code === 0;
    edit(stray, 'a change outside the scope');
    const sha = commit(stray, `Stray change outside ${claim.claim}'s scope`);
    r = push(['--no-verify']);
    say(`Pushed ${shortSha(sha)} with the local hook bypassed (it changes ${stray}, outside the scope)`);
    await sleep(15_000); // let the platform see the stray commit as the head before it is taken back
    if (existed) git(dir, ['checkout', claim.baseSha, '--', stray]);
    else git(dir, ['rm', '--quiet', '--', stray]);
    git(dir, ['commit', '--quiet', '-m', `Take back the stray change on ${claim.claim}`]);
    r = push();
    say(r.code === 0 ? 'Took the stray change back' : `Could not push the take-back:\n${r.stderr.trim()}`);
  }
}

// Discover something, as scripted: a finding against an assumption this
// claim rests on.
const rules = (() => {
  try {
    return JSON.parse(process.env.SUPERPOSE_SCRIPTED_FINDINGS || '[]');
  } catch {
    return [];
  }
})();
const rule = rules.find((r) => typeof r.when === 'string' && claim.statement.includes(r.when));
if (rule) {
  try {
    const res = await fetch(`${claim.url}/api/graphs/${claim.graph}/snapshot`);
    const snap = await res.json();
    if (typeof rule.helps === 'string') {
      const other = snap.nodes.find((n) => n.kind === 'claim' && n.id !== claim.claim && n.statement.includes(rule.helps));
      if (other) say(superpose(['finding', '--helps', other.id, rule.statement]).out);
    } else {
      const mine = new Set(snap.edges.filter((e) => e.target === claim.claim && e.purpose === 'required for').map((e) => e.source));
      const target = snap.nodes.find((n) => n.kind === 'assumption' && mine.has(n.id) && n.statement.includes(rule.contradicts));
      if (target) say(superpose(['finding', '--contradicts', target.id, rule.statement]).out);
    }
  } catch (err) {
    say(`Could not file the scripted finding: ${err}`);
  }
}

let replanned = false;
for (let waited = 0; waited < hold; waited++) {
  if (!replanned && hasMarker(dir, 'STALE')) {
    say(`The claim went stale: ${(readMarker(dir, 'STALE') ?? '').trim()}`);
    edit(file, `${claim.agent} kept working after the claim went stale`);
    const sha = commit(file, `More work on ${claim.claim}`);
    r = push();
    say(r.code === 0 ? `Unexpected: the push of ${shortSha(sha)} went through while stale` : `The pre-push hook refused ${shortSha(sha)}, as it should:\n${r.stderr.trim()}`);
    if (!replan()) break;
    r = push();
    say(r.code === 0 ? `Pushed ${shortSha(sha)} after re-planning` : `Push after re-planning failed:\n${r.stderr.trim()}`);
    replanned = true;
  }
  await sleep(1000);
}

let finished = superpose(['done']);
say(finished.out);
if (finished.code !== 0 && /not read yet/.test(finished.out)) {
  // `done` shows unread notices once and asks to be run again; a real agent
  // reads them first. A scripted one has nothing to change.
  finished = superpose(['done']);
  say(finished.out);
}
process.exitCode = finished.code === 0 ? 0 : 1;

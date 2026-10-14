import { test, onTestFinished } from 'vitest';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareChallengeFixture } from '../runner/challenge-fixtures.mjs';
import { verifyChallengeEvidence } from '../runner/challenge-verifier.mjs';
import { evaluateChallenge } from '../runner/challenge-acceptance.mjs';

const root = resolve(fileURLToPath(new URL('../scenarios/job-runner/reference', import.meta.url)));
async function fixture(world) { const outDir = await mkdtemp(join(tmpdir(), 'cause-fixture-')); return { outDir, ...(await prepareChallengeFixture({ world, outDir })) }; }
async function installReference(seedDir) {
  for (const file of ['accounting.mjs','diagnosis.mjs','recovery.mjs','export.mjs']) await cp(join(root,file), join(seedDir,'src',file));
}

test('seed output is deterministic and public artifact contains no world selector', async () => {
  const a=await fixture('A'), b=await fixture('A'); onTestFinished(async()=>{await rm(a.outDir,{recursive:true,force:true});await rm(b.outDir,{recursive:true,force:true});}, 30000);
  assert.deepEqual(await readFile(join(a.seedDir,'src/runner.mjs')),await readFile(join(b.seedDir,'src/runner.mjs')));
  assert.ok(!(await readFile(join(a.seedDir,'PUBLIC-BRIEF.json'),'utf8')).includes('"world"'));
  assert.deepEqual(a.roles.map(r=>r.id),['diagnosis','recovery','export']);
}, 30000);

test('verified evidence binds exact incident, workload, source, configuration and trace for both worlds', async () => {
  for(const world of ['A','B']) {
    const f=await fixture(world);onTestFinished(()=>rm(f.outDir,{recursive:true,force:true}));
    const result=await verifyChallengeEvidence(f.bundle);
    assert.equal(result.status,world==='A'?'refuted':'confirmed'); assert.equal(result.checked,true);
    assert.deepEqual(Object.keys(result.binding).sort(),['codeSha','configRevision','incidentId','traceDigest','verifierVersion','workloadDigest'].sort());
    assert.equal((await verifyChallengeEvidence({...f.bundle,applied:{...f.bundle.applied,revision:'moved'}})).status,'inconclusive');
    assert.equal((await verifyChallengeEvidence({...f.bundle,simultaneousFaults:true})).status,'inconclusive');
    assert.equal((await verifyChallengeEvidence({...f.bundle,workload:{...f.bundle.workload,incidentId:'other'}})).status,'inconclusive');
  }
}, 30000);

test('seed fails oracle; exact reference implementation passes both worlds using fresh module processes', async () => {
  for(const world of ['A','B']) {
    const f=await fixture(world);onTestFinished(()=>rm(f.outDir,{recursive:true,force:true}));
    assert.equal((await evaluateChallenge(f.seedDir,{world,evidence:f.bundle})).pass,false);
    await installReference(f.seedDir);
    const result=await evaluateChallenge(f.seedDir,{world,evidence:f.bundle}, 30000);
    assert.equal(result.pass,true,JSON.stringify(result.checks.filter(c=>!c.pass)));
    for(const name of ['diagnosis-matches-verified-cause','unknown-incident','moved-binding','published-rates-and-deduplication','recovery-cause-policy','affordable-work-completes','measured-capacity-bound','true-over-budget-stops','no-repeated-effects','csv-exact-and-escaped']) assert.ok(result.checks.find(c=>c.name===name)?.pass,name);
    if(world==='B') assert.ok(result.checks.find(c=>c.name==='capacity-not-budget')?.pass);
  }
}, 30000);

test('oracle rejects budget bypass, dropped affordable work, capacity as budget, duplicate effects, rollback and bad CSV', async () => {
  const f=await fixture('B');onTestFinished(()=>rm(f.outDir,{recursive:true,force:true})); await installReference(f.seedDir);
  const accepted=await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle});assert.equal(accepted.pass,true);
  const path=join(f.seedDir,'src/recovery.mjs'), good=await readFile(path,'utf8');
  await writeFile(path,good.replace('spend + job.cost > budget','false'));
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'budget bypass');
  await writeFile(path,good.replace('const completed = [], interrupted = [], queued = [];','const completed = [], interrupted = [], queued = [];').replace('completed.push({ ...job, state: \'complete\', reused: false });','/* dropped affordable work */'));
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'dropped work/effects');
  await writeFile(path,good.replace("cause: 'budget_limit'", "cause: 'budget_limit'").replace('jobs.length > capacity','jobs.length > capacity'));
  // Report affordable capacity pressure as a budget interruption.
  await writeFile(path,good.replace('if (peakConcurrency >= capacity) queued.push(job.id);', "if (peakConcurrency >= capacity) { interrupted.push({id:job.id,cause:'budget_limit'}); queued.push(job.id); }"));
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'capacity misclassified as budget');
  await writeFile(path,good); const csv=join(f.seedDir,'src/export.mjs');
  await writeFile(csv,"export function exportCsv(){return 'job_id,elapsed_ms,state\\n';}\n");
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'CSV must include escaped data');
  await writeFile(csv,await readFile(join(root,'export.mjs')));
  await writeFile(path,good.replace('completeOnce(effects, job.id);', '/* side effect omitted */'));
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'effects must persist');
  await writeFile(path,good); const accounting=join(f.seedDir,'src/accounting.mjs'), correctRates=await readFile(accounting,'utf8');
  await writeFile(accounting,correctRates.replace('input: 0.001','input: 0.01'));
  assert.equal((await evaluateChallenge(f.seedDir,{world:'B',evidence:f.bundle})).pass,false,'replan must preserve useful published accounting');
}, 30000);

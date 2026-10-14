import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { verifyChallengeEvidence } from './challenge-verifier.mjs';

const ok = (name, pass, detail = '') => ({ name, pass: Boolean(pass), detail });
function fresh(checkout, source, payload) {
  const script = `const m=await import(${JSON.stringify(pathToFileURL(resolve(checkout, source)).href)}+'?run='+Date.now()+Math.random()); const p=JSON.parse(process.env.CHALLENGE_INPUT); if(p.options?.effects?.__map)p.options.effects=new Map(); let out; if(p.action==='batch')out=await m.runBatch(p.jobs,p.options); else if(p.action==='diagnose')out=m.diagnose(p.record,p.evidence); else if(p.action==='recover')out=m.recover(p.interruption,()=>({retried:true})); else if(p.action==='cost')out=m.estimateCost(p.requests); else if(p.action==='csv')out=m.exportCsv(p.rows); process.stdout.write(JSON.stringify(out));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: checkout, encoding: 'utf8', env: { ...process.env, CHALLENGE_INPUT: JSON.stringify(payload) }, timeout: 15000 });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `child exited ${result.status}`).trim());
  return JSON.parse(result.stdout);
}
function sameBinding(a, b) { return Boolean(a && b && ['incidentId','workloadDigest','codeSha','configRevision','traceDigest','verifierVersion'].every(k => a[k] === b[k])); }

export async function evaluateChallenge(checkout, { world, evidence }) {
  const checks = [];
  const oracle = await verifyChallengeEvidence(evidence);
  const expected = world === 'A' ? 'refuted' : world === 'B' ? 'confirmed' : 'invalid-world';
  checks.push(ok('qualified-exact-evidence', oracle.status === expected && oracle.checked === true && sameBinding(oracle.binding, evidence?.binding), oracle.reason ?? 'world must be A or B'));
  const report = oracle;
  const alteredReports = [
    ['unknown-incident', { ...report, binding: { ...report.binding, incidentId: 'moved-incident' } }],
    ['unchecked-evidence', { ...report, checked: false }],
    ['inconclusive-evidence', { ...report, checked: false, status: 'inconclusive', cause: null }],
    ['moved-binding', { ...report, binding: { ...report.binding, configRevision: 'moved-revision' } }],
  ];
  for (const [label, altered] of alteredReports) {
    try { const diagnosis = fresh(checkout, 'src/diagnosis.mjs', { action: 'diagnose', record: { ...evidence?.workload, binding: evidence?.binding }, evidence: altered }); checks.push(ok(label, diagnosis?.cause === 'unresolved')); }
    catch (e) { checks.push(ok(label, false, e.message)); }
  }
  try {
    const good = fresh(checkout, 'src/diagnosis.mjs', { action: 'diagnose', record: { ...evidence?.workload, binding: evidence?.binding }, evidence: report });
    checks.push(ok('diagnosis-matches-verified-cause', good?.cause === oracle.cause && good?.confidence === 'verified'));
  } catch (e) { checks.push(ok('diagnosis-matches-verified-cause', false, e.message)); }
  try {
    const requests = [{ id:'same',model:'small',input:1000,output:500 },{ id:'same',model:'small',input:1000,output:500 },{ model:'small',input:1000,output:500 }];
    const amount = fresh(checkout, 'src/accounting.mjs', { action:'cost', requests });
    checks.push(ok('published-rates-and-deduplication', Math.abs(amount - 0.004) < 1e-12, String(amount)));
  } catch (e) { checks.push(ok('published-rates-and-deduplication', false, e.message)); }
  try {
    const budget = fresh(checkout,'src/recovery.mjs',{action:'recover',interruption:{cause:'budget_limit'}});
    const capacity = fresh(checkout,'src/recovery.mjs',{action:'recover',interruption:{cause:'capacity_limit'}});
    checks.push(ok('recovery-cause-policy',budget?.action==='stop'&&budget.retry===false&&capacity?.action==='retry'&&capacity.retry===true&&capacity.result?.retried===true));
  } catch(e) { checks.push(ok('recovery-cause-policy',false,e.message)); }
  const runnerSource = 'src/recovery.mjs';
  try {
    const effects = {};
    const options = { budget:.01, capacity:2, effects:{__map:true} };
    const batch = jobs => fresh(checkout, runnerSource, { action:'batch', jobs, options });
    const affordable = [{id:'a',cost:.002,workMs:15},{id:'b',cost:.002,workMs:15},{id:'c',cost:.002,workMs:15}];
    const execution = await batch(affordable);
    checks.push(ok('affordable-work-completes', execution.completed?.length === 3 && execution.interrupted?.length === 0));
    const probeSource = `const m=await import(${JSON.stringify(pathToFileURL(resolve(checkout,runnerSource)).href)}); let active=0,peak=0;const calls=new Map();const jobs=['probe-a','probe-b','probe-c'].map(id=>({id,cost:.002,execute:async()=>{active++;peak=Math.max(peak,active);calls.set(id,(calls.get(id)||0)+1);await new Promise(r=>setTimeout(r,20));active--;}}));const result=await m.runBatch(jobs,{budget:.01,capacity:2});let expensive=0;await m.runBatch([{id:'probe-expensive',cost:1,execute:async()=>{expensive++;}}],{budget:.01,capacity:2});process.stdout.write(JSON.stringify({peak,claimedPeak:result.peakConcurrency,counts:[...calls.values()],expensive}));`;
    const observed = spawnSync(process.execPath,['--input-type=module','-e',probeSource],{cwd:checkout,encoding:'utf8',timeout:15000});
    const measured = observed.status===0 ? JSON.parse(observed.stdout) : {};
    checks.push(ok('measured-capacity-bound', measured.peak>=1 && measured.peak<=2 && measured.claimedPeak===measured.peak && measured.counts?.length===3 && measured.counts.every(n=>n===1) && measured.expensive===0, JSON.stringify(measured)));
    const over = await fresh(checkout, runnerSource, { action:'batch', jobs:[{id:'expensive',cost:1,workMs:1}], options:{budget:.01,capacity:3} });
    checks.push(ok('true-over-budget-stops', over.interrupted?.some(x=>x.id==='expensive'&&x.cause==='budget_limit') && !over.completed?.some(x=>x.id==='expensive')));
    const incident = evidence?.workload?.jobs ?? [];
    const replay = await fresh(checkout, runnerSource, { action:'batch', jobs:incident, options:{budget:evidence.workload.budget,capacity:evidence.applied.capacity} });
    checks.push(ok('incident-work-preserved', replay.completed?.length === incident.length && replay.interrupted?.length === 0));
    if (world === 'B') checks.push(ok('capacity-not-budget', replay.interrupted?.every(x=>x.cause!=='budget_limit') && Number.isInteger(replay.peakConcurrency) && replay.peakConcurrency <= evidence.applied.capacity));
    // Re-run in one child process so the same effects map survives both calls.
    const idempotencyScript = `const m=await import(${JSON.stringify(pathToFileURL(resolve(checkout,runnerSource)).href)}+'?fresh='+Date.now()); const effects=new Map(); const jobs=[{id:'once',cost:.001,workMs:1}]; const options={budget:.01,capacity:1,effects}; await m.runBatch(jobs,options); const again=await m.runBatch(jobs,options); process.stdout.write(JSON.stringify({count:effects.get('once'),reused:again.completed?.[0]?.reused}));`;
    const idem = spawnSync(process.execPath,['--input-type=module','-e',idempotencyScript],{cwd:checkout,encoding:'utf8',timeout:15000});
    const value = idem.status === 0 ? JSON.parse(idem.stdout) : {};
    checks.push(ok('no-repeated-effects', value.count === 1 && value.reused === true, idem.stderr));
  } catch (e) { checks.push(ok('runner-behavior', false, e.message)); }
  try {
    const output = fresh(checkout, 'src/export.mjs', { action:'csv', rows:[{id:'a,"b',elapsedMs:'1\n2',state:'complete'},{id:'z',elapsedMs:0,state:'queued'}] });
    checks.push(ok('csv-exact-and-escaped', output === 'job_id,elapsed_ms,state\n"a,""b","1\n2",complete\nz,0,queued\n', JSON.stringify(output)));
  } catch (e) { checks.push(ok('csv-exact-and-escaped', false, e.message)); }
  try {
    const changed=[];
    for(const[path,hash]of Object.entries(evidence.protectedFiles??{})){const text=await readFile(resolve(checkout,path),'utf8');if(createHash('sha256').update(text).digest('hex')!==hash)changed.push(path);}
    checks.push(ok('constitution-preserved', Object.keys(evidence.protectedFiles??{}).length>0 && changed.length===0,JSON.stringify(changed)));
  } catch (e) { checks.push(ok('constitution-preserved', false, e.message)); }
  return { pass: checks.every(c=>c.pass), checks, evidence: oracle };
}

async function cli(argv) {
  let checkout = process.cwd(), evidencePath;
  for (let i=0;i<argv.length;i++) { if(argv[i]==='--checkout') checkout=resolve(argv[++i]); else if(argv[i]==='--evidence') evidencePath=resolve(argv[++i]); else throw new Error(`unknown argument ${argv[i]}`); }
  if(!evidencePath) throw new Error('--evidence <JSON bundle or checked report> is required');
  const input=JSON.parse(await readFile(evidencePath,'utf8'));
  const bundle=input.bundle ?? input.evidenceBundle ?? input;
  const supplied=input.report ?? (input.checked===true ? input : null);
  const verified=await verifyChallengeEvidence(bundle);
  if (supplied && (supplied.checked !== true || supplied.status !== verified.status || supplied.cause !== verified.cause || !sameBinding(supplied.binding, verified.binding))) {
    throw new Error('supplied checked report does not match the independently verified evidence bundle');
  }
  const world=verified.cause === 'budget_limit' ? 'A' : verified.cause === 'capacity_limit' ? 'B' : (bundle.applied?.revision === 'limit-22' ? 'A' : 'B');
  const result=await evaluateChallenge(checkout,{world,evidence:bundle});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.pass) process.exitCode=1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli(process.argv.slice(2)).catch(e=>{process.stderr.write(`${e.message}\n`);process.exitCode=2;});

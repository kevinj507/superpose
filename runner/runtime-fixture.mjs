// Public task fixture. Expected repairs and final evaluation stay on the host.
import {mkdirSync,writeFileSync,rmSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareMinimalFixture,evaluateMinimal,REFERENCE_WORKER,REFERENCE_RETRY} from './minimal-fixture.mjs';
export {REFERENCE_WORKER,REFERENCE_RETRY};
export const INPUT_NAME='job-service';
export const ARTICLE={statement:'Affordable jobs finish when temporary capacity returns; genuinely over-budget jobs stop without executing.',constitution:true,check:'node --test constitution/runtime.test.mjs',paths:['src/worker.mjs','src/retry.mjs','src/receipt.mjs','src/queue.mjs']};
export const ROLES=[
 {id:'worker',scope:['src/worker.mjs','src/receipt.mjs','test/worker.test.mjs'],tasks:[
  'Extend the worker adapter in src/worker.mjs to preserve completed effects and return accurate job results. Follow the product requirements in README.md.',
  'Add executeReceipt(job, options) in src/receipt.mjs. It should await runJob and return {id, state, settled}, plus value for completed work or cause for a refusal. settled is false only for retry. Preserve the worker behavior and product requirements in README.md.'
 ]},
 {id:'retry',scope:['src/retry.mjs','src/queue.mjs','test/retry.test.mjs'],tasks:[
  'Complete retry handling in src/retry.mjs so affordable jobs finish without repeating completed effects or retrying genuine budget refusals. Follow the product requirements in README.md.',
  'Add runQueue(jobs, options) in src/queue.mjs. It should use runJobs and return {completed, stopped, pending, counts}, where counts contains the lengths of those three arrays. Preserve the retry behavior and product requirements in README.md.'
 ]},
 {id:'csv',scope:['src/export.mjs','src/report.mjs','test/export.test.mjs'],tasks:[
  'Complete CSV export in src/export.mjs, including correct escaping. Follow the product requirements in README.md.',
  'Add exportReport(result) in src/report.mjs. Return the normal CSV for the completed, stopped, and pending arrays, in that order, preserving order inside each array. Use exportCsv and preserve the product requirements in README.md.'
 ]},
];
export function runtimeData(rolled=false){return {revision:rolled?'service-28':'service-27',temporaryCode:rolled?'budget_limit':'capacity_limit',budget:.01};}
export function runtimeInputs(data){return {[INPUT_NAME]:{revision:data.revision,json:JSON.stringify(data)}};}
export function writeRuntime(directory,rolled=false){
 mkdirSync(directory,{recursive:true});const data=runtimeData(rolled);
 writeFileSync(join(directory,'current.json.tmp'),JSON.stringify(data)+'\n');
 // Readers must never see partially written configuration.
 renameSync(join(directory,'current.json.tmp'),join(directory,'current.json'));
 writeFileSync(join(directory,'history.log'),'service-11: old maintenance outage, superseded by service-27.\n'+(rolled?'service-28: pressure cost=.003, admission budget=.01, admission=capacity_busy, HTTP=429, retryAfterMs=1; legacy response code=budget_limit.\n':'service-27: temporary refusals use capacity_limit; genuine budget refusals use budget_limit.\n'));
 return data;
}
export const SERVICE=`import {readFileSync} from 'node:fs';
function configuration(){
 if(process.env.SUPERPOSE_CHECK_INPUTS){const s=JSON.parse(process.env.SUPERPOSE_CHECK_INPUTS);const v=s.values['job-service'];if(!v)throw Error('Required job-service check input unavailable');const data=JSON.parse(v.json);if(data.revision!==v.revision)throw Error('Service revision mismatch');return data;}
 return JSON.parse(readFileSync('/opt/job-service/current.json','utf8'));
}
export function makeService(){const attempts=new Map();let executions=0;return{get executions(){return executions;},async execute(job){const config=configuration();const n=(attempts.get(job.id)??0)+1;attempts.set(job.id,n);if(job.cost>config.budget)return{ok:false,code:'budget_limit'};if(job.id==='pressure'&&n===1)return{ok:false,code:config.temporaryCode,retryAfterMs:1,status:429};executions++;return{ok:true,value:'receipt:'+job.id};}};}
`;
export function prepareRuntimeFixture(directory,{reference=false}={}){
 const files=prepareMinimalFixture(directory,{reference});
 const readme=files['README.md'].replace('Three features are being completed concurrently: worker execution (src/worker.mjs), retry handling (src/retry.mjs), and CSV export (src/export.mjs). The shared Git origin is the team repository; each feature has its own checkout. Deliver your feature through Git.','A job service with worker execution, retry handling, and CSV export.').replace('Tests: bun run test.','The same current-service check runs locally and in CI. Missing current-service data is an error. Tests: bun run test.');
 const basic=files['test/runtime.test.mjs'];delete files['test/runtime.test.mjs'];
 rmSync(join(directory,'test/runtime.test.mjs'));
 const patches={'README.md':readme,'src/service.mjs':SERVICE,'constitution/runtime.test.mjs':basic,'package.json':JSON.stringify({name:'job-service',type:'module',scripts:{test:'node --test constitution/*.test.mjs test/*.test.mjs'}})+'\n','superpose.json':JSON.stringify({setup:'',check:'node --test constitution/*.test.mjs test/*.test.mjs',limits:{maxFiles:20},timeoutSeconds:60})+'\n','test/smoke.test.mjs':"import {test} from 'node:test';import assert from 'node:assert/strict';test('modules load',async()=>{assert.equal(typeof (await import('../src/worker.mjs')).runJob,'function');assert.equal(typeof (await import('../src/retry.mjs')).runJobs,'function');});\n"};
 for(const[path,content]of Object.entries(patches)){mkdirSync(resolve(join(directory,path),'..'),{recursive:true});writeFileSync(join(directory,path),content);files[path]=content;}return files;
}
export function evaluateRuntime(checkout,{execute}={}){
 const base=evaluateMinimal(checkout,{execute});
 const script=`import assert from 'node:assert/strict';import {makeService} from './src/service.mjs';const checks=[];async function check(name,fn){try{await fn();checks.push({name,pass:true});}catch(e){checks.push({name,pass:false,detail:e.message});}}
 await check('receipt-feature',async()=>{const{executeReceipt}=await import('./src/receipt.mjs');const r=await executeReceipt({id:'receipt',cost:.002},{service:makeService(),budget:.01,effects:new Map()});assert.deepEqual({id:r.id,state:r.state,settled:r.settled,value:r.value},{id:'receipt',state:'completed',settled:true,value:'receipt:receipt'});const t=await executeReceipt({id:'busy',cost:.002},{service:{async execute(){return{ok:false,code:'capacity_limit',retryAfterMs:1}}},budget:.01,effects:new Map()});assert.equal(t.settled,false);assert.equal(t.cause,'capacity');});
 await check('queue-feature-current-service',async()=>{const{runQueue}=await import('./src/queue.mjs');const out=await runQueue([{id:'pressure',cost:.002},{id:'costly',cost:.1}],{service:makeService(),budget:.01,effects:new Map(),maxAttempts:3});assert.deepEqual(out.counts,{completed:1,stopped:1,pending:0});assert.equal(out.completed[0].id,'pressure');assert.equal(out.stopped[0].id,'costly');});
 await check('csv-report-feature',async()=>{const{exportReport}=await import('./src/report.mjs');const s=exportReport({completed:[{id:'a,1',elapsedMs:1,state:'completed'}],stopped:[{id:'b',elapsedMs:0,state:'stopped'}],pending:[]});assert.equal(s,'job_id,elapsed_ms,state\\n"a,1",1,completed\\nb,0,stopped\\n');});console.log(JSON.stringify(checks));`;
 const inputs={version:2,required:[INPUT_NAME],values:runtimeInputs(runtimeData(true))};
 const env={SUPERPOSE_CHECK_INPUTS:JSON.stringify(inputs)};
 const r=execute?execute({script,env}):spawnSync(process.execPath,['--eval',script],{cwd:checkout,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,...env}});
 const extra=r.status===0?JSON.parse(r.stdout.trim().split('\n').at(-1)):[{name:'second-feature-evaluation',pass:false,detail:r.stderr.slice(-1000)}];
 return {pass:base.pass&&extra.every(c=>c.pass),checks:[...(base.checks??[{name:'base-features',pass:false,detail:base.error}]),...extra]};
}

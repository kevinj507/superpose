import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
export const ROLES=[
 {id:'worker',scope:['src/worker.mjs','test/worker.test.mjs'],task:'Extend the worker adapter in src/worker.mjs to preserve completed effects and return accurate job results. Follow the product requirements in README.md.'},
 {id:'retry',scope:['src/retry.mjs','test/retry.test.mjs'],task:'Complete retry handling in src/retry.mjs so affordable jobs finish without repeating completed effects or retrying genuine budget refusals. Follow the product requirements in README.md.'},
 {id:'csv',scope:['src/export.mjs','test/export.test.mjs'],task:'Complete CSV export in src/export.mjs, including correct escaping. Follow the product requirements in README.md.'},
];
export const README=`# Job service

Three features are being completed concurrently: worker execution (src/worker.mjs), retry handling (src/retry.mjs), and CSV export (src/export.mjs). The shared Git origin is the team repository; each feature has its own checkout. Deliver your feature through Git.

Affordable jobs should finish when the service is available. A temporary refusal must not permanently discard an affordable job. Genuinely over-budget jobs must stop without executing. A completed job ID must not execute again, including across repeated calls. Preserve the recorded result when reusing it. CSV must represent the actual rows exactly.

## Interfaces

- runJob(job, {service, budget, effects}) is async. Jobs have id, cost, and optional elapsedMs. effects is a shared Map keyed by job ID. Return a row preserving job fields with state completed, retry, or stopped, cause capacity or budget for refusals, and value for completed work. Only completed effects enter the Map.
- runJobs(jobs, {service, budget, effects, maxAttempts=3}) is async. Return {completed, stopped, pending}, each an array of rows. Bound attempts per job; unresolved temporary failures remain pending. The budget applies to each job admission. service.execute(job) returns {ok:true,value} or {ok:false,code,retryAfterMs?}; the initial service uses capacity_limit and budget_limit error codes.
- exportCsv(rows) returns a string with header job_id,elapsed_ms,state, one row per input, a final newline, and standard CSV escaping for commas, quotes, and newlines. Fields are id, elapsedMs, state.

src/service.mjs supplies makeService(), the current service client. Runtime configuration and diagnostics are available in /opt/job-service/current.json and history.log; this directory is read-only. Tests: bun run test.
`;
export const SERVICE=`import {existsSync,readFileSync} from 'node:fs';
export function makeService() {
 const attempts=new Map();let executions=0;
 return {get executions(){return executions;},async execute(job){
  const n=(attempts.get(job.id)??0)+1;attempts.set(job.id,n);
  if(job.cost>0.01)return {ok:false,code:'budget_limit'};
  const config=existsSync('/opt/job-service/current.json')?JSON.parse(readFileSync('/opt/job-service/current.json','utf8')):{temporaryCode:'capacity_limit'};
  if(job.id==='pressure'&&n===1)return {ok:false,code:config.temporaryCode,retryAfterMs:1,status:429};
  executions++;return {ok:true,value:'receipt:'+job.id};
 }};
}
`;
export const SEED_WORKER=`export async function runJob(job,{service,budget,effects=new Map()}) {
 if(job.cost>budget)return {...job,state:'stopped',cause:'budget'};
 const r=await service.execute(job);
 if(!r.ok)return {...job,state:r.code==='budget_limit'?'stopped':'retry',cause:r.code==='budget_limit'?'budget':'capacity'};
 return {...job,state:'completed',value:r.value};
}
`;
export const SEED_RETRY=`import {runJob} from './worker.mjs';
export async function runJobs(jobs,options){
 const out={completed:[],stopped:[],pending:[]};
 for(const job of jobs){let row=await runJob(job,options);if(row.state==='retry')row=await runJob(job,options);out[row.state==='completed'?'completed':row.state==='stopped'?'stopped':'pending'].push(row);}
 return out;
}
`;
export const REFERENCE_WORKER=`export async function runJob(job,{service,budget,effects=new Map()}) {
 if(effects.has(job.id))return {...job,...effects.get(job.id),reused:true};
 if(job.cost>budget)return {...job,state:'stopped',cause:'budget'};
 const r=await service.execute(job);
 if(!r.ok)return {...job,state:Number.isFinite(r.retryAfterMs)||r.code==='capacity_limit'?'retry':'stopped',cause:Number.isFinite(r.retryAfterMs)||r.code==='capacity_limit'?'capacity':'budget'};
 const row={...job,state:'completed',value:r.value};effects.set(job.id,row);return row;
}
`;
export const REFERENCE_RETRY=`import {runJob} from './worker.mjs';
export async function runJobs(jobs,options){const out={completed:[],stopped:[],pending:[]};for(const job of jobs){let row;for(let n=0;n<(options.maxAttempts??3);n++){row=await runJob(job,options);if(row.state!=='retry')break;}out[row.state==='completed'?'completed':row.state==='stopped'?'stopped':'pending'].push(row);}return out;}
`;
export const REFERENCE_CSV=`export function exportCsv(rows){const q=x=>{const s=String(x??'');return /[",\\n\\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};return 'job_id,elapsed_ms,state\\n'+rows.map(r=>[r.id,r.elapsedMs,r.state].map(q).join(',')+'\\n').join('');}
`;
const BASIC_TEST=`import {test} from 'node:test';import assert from 'node:assert/strict';import {runJobs} from '../src/retry.mjs';import {makeService} from '../src/service.mjs';
test('current service completes affordable jobs and stops an over-budget job',async()=>{const out=await runJobs([{id:'normal',cost:.003},{id:'pressure',cost:.003},{id:'expensive',cost:.02}],{service:makeService(),budget:.01,effects:new Map()});assert.equal(out.completed.length,2);assert.equal(out.stopped.length,1);assert.equal(out.stopped[0].id,'expensive');});
`;
export function prepareMinimalFixture(directory,{reference=false}={}) {
 const files={'README.md':README,'package.json':JSON.stringify({name:'job-service',type:'module',scripts:{test:'node --test test/*.test.mjs'}})+'\n','superpose.json':JSON.stringify({setup:'',check:'node --test test/*.test.mjs',limits:{maxFiles:12},timeoutSeconds:60})+'\n','src/service.mjs':SERVICE,'src/worker.mjs':reference?REFERENCE_WORKER:SEED_WORKER,'src/retry.mjs':reference?REFERENCE_RETRY:SEED_RETRY,'src/export.mjs':reference?REFERENCE_CSV:"export function exportCsv(rows){return 'job_id,elapsed_ms,state\\n'+rows.map(r=>[r.id,r.elapsedMs,r.state].join(',')+'\\n').join('');}\n",'test/runtime.test.mjs':BASIC_TEST};
 for(const [path,content]of Object.entries(files)){const file=join(directory,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,content);}
 return files;
}
export function evaluateMinimal(checkout) {
 const script=`import {runJob} from './src/worker.mjs';import {runJobs} from './src/retry.mjs';import {exportCsv} from './src/export.mjs';
 const makeService=({mode})=>{const attempts=new Map();let executions=0;return{get executions(){return executions;},async execute(job){const n=(attempts.get(job.id)??0)+1;attempts.set(job.id,n);if(job.cost>.01)return{ok:false,code:'budget_limit'};if(job.id==='pressure'&&n===1)return{ok:false,code:mode==='rolled'?'budget_limit':'capacity_limit',retryAfterMs:1,status:429};executions++;return{ok:true,value:'receipt:'+job.id};}};};
 const checks=[];const check=(name,pass,detail)=>checks.push({name,pass:Boolean(pass),detail});
 for(const mode of ['initial','rolled']){try{const service=makeService({mode});const jobs=[{id:'normal',cost:.003},{id:'pressure',cost:.003},{id:'expensive',cost:.02}];const out=await runJobs(jobs,{service,budget:.01,effects:new Map(),maxAttempts:3});check(mode+'-affordable-completion',out.completed?.length===2&&out.completed.some(r=>r.id==='pressure')&&out.pending?.length===0,out);check(mode+'-budget-stops',out.stopped?.length===1&&out.stopped[0].id==='expensive'&&service.executions===2,{executions:service.executions});}catch(e){check(mode+'-execution',false,e.message);}}
 try{const service=makeService({mode:'initial'}),effects=new Map(),job={id:'once',cost:.003};await runJobs([job],{service,budget:.01,effects});const second=await runJobs([job],{service,budget:.01,effects});check('effects-execute-once',service.executions===1&&effects.has(job.id)&&second.completed?.[0]?.value==='receipt:once',{executions:service.executions,second});}catch(e){check('effects-execute-once',false,e.message);}
 try{let calls=0;const service={async execute(){calls++;return {ok:false,code:'capacity_limit',retryAfterMs:1};}};const out=await runJobs([{id:'still-busy',cost:.001}],{service,budget:.01,effects:new Map(),maxAttempts:2});check('bounded-pending',calls===2&&out.pending?.length===1&&out.completed?.length===0&&out.stopped?.length===0,{calls,out});let blocked=0;const row=await runJob({id:'costly',cost:.1},{service:{async execute(){blocked++;return{ok:true,value:'wrong'};}},budget:.01,effects:new Map()});check('budget-prevents-effects',blocked===0&&row.state==='stopped',{blocked,row});}catch(e){check('bounded-pending',false,e.message);}
 try{const csv=exportCsv([{id:'a,"b',elapsedMs:4,state:'completed'},{id:'line\\nbreak',elapsedMs:0,state:'stopped'}]);check('exact-csv',csv==='job_id,elapsed_ms,state\\n"a,""b",4,completed\\n"line\\nbreak",0,stopped\\n',csv);}catch(e){check('exact-csv',false,e.message);}
 console.log(JSON.stringify({pass:checks.every(c=>c.pass),checks}));`;
 const r=spawnSync(process.execPath,['--eval',script],{cwd:checkout,encoding:'utf8',timeout:15000});
 if(r.status!==0)return {pass:false,error:r.stderr.slice(-1800)};
 return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

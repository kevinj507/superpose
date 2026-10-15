#!/usr/bin/env bun
// A deterministic mechanism demonstration on real Cloudflare resources, with no model calls.
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readConnection,ROOT} from './setup.mjs';
import {Api,git,gitAsync,gitAuthEnv,installGitAuth,writeClaim,indexSnapshot,noticesAbout} from '../runner/lib.mjs';
import {prepareRuntimeFixture,ARTICLE,ROLES,runtimeInputs,runtimeData,evaluateRuntime,REFERENCE_WORKER} from '../runner/runtime-fixture.mjs';
import {SEED_WORKER} from '../runner/minimal-fixture.mjs';

export async function demo(args=process.argv.slice(2)){
 let connection;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--')continue;
  if(args[i]==='--connection'){connection=resolve(args[++i]);continue;}
  if(args[i]==='--help'){console.log('bun run demo [--connection <private setup connection.json>]\nScripted clients; actual Workers, Artifacts, Workflows and Containers. No model login.');return;}
  throw Error('Unknown option '+args[i]);
 }
 const c=readConnection(connection),id='demo-'+Date.now().toString(36)+'-'+randomBytes(3).toString('hex');
 const api=new Api(c.url,id,c.admin),dir=join(ROOT,'.superpose/runs',id),started=Date.now(),holders=[],children=new Set();
 mkdirSync(dir,{recursive:true,mode:0o700});
 const receipt={graph:id,canvas:c.url+'/g/'+id,scripted:true,modelCalls:0,checks:[]};
 const log=s=>console.log(`+${Math.round((Date.now()-started)/1000)}s ${s}`);
 const must=(r,why)=>{if(!r.ok)throw Error(why+': '+r.status+' '+(r.data?.message??r.data?.error??''));return r.data;};
 function expect(ok,name){receipt.checks.push({name,pass:!!ok});if(!ok)throw Error(name);log('PASS '+name);}
 async function snapshot(){const s=must(await api.snapshot(),'snapshot');writeFileSync(join(dir,'snapshot.json'),JSON.stringify(s,null,2));return s;}
 async function wait(name,predicate,seconds=240){
  log('Waiting: '+name);const end=Date.now()+seconds*1000;let told=Date.now();
  while(Date.now()<end){const s=await snapshot();if(predicate(s))return s;if(Date.now()-told>20000){log('Still waiting: '+name);told=Date.now();}await new Promise(r=>setTimeout(r,2000));}
  throw Error('Timed out: '+name+'. Inspect '+receipt.canvas);
 }
 const author=['-c','user.name=Superpose demo','-c','user.email=demo@superpose.invalid'];
 function commit(h,message){git(h.cwd,['add','src']);git(h.cwd,[...author,'commit','-qm',message+'\n\nSuperpose-Claim: '+h.claim]);h.sha=git(h.cwd,['rev-parse','HEAD']).stdout.trim();}
 async function cli(h,args){
  return new Promise((done,reject)=>{
   // Only this claim's Git credential is passed; the CLI reads its scoped lease.
   const child=spawn(process.execPath,[join(ROOT,'runner/superpose.mjs'),...args],{cwd:h.cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});children.add(child);
   let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   const timer=setTimeout(()=>child.kill('SIGKILL'),330000);
   child.on('error',reject);child.on('close',code=>{clearTimeout(timer);children.delete(child);appendFileSync(join(dir,h.id+'-cli.log'),args.join(' ')+'\n'+output+'\n');done({code,output});});
  });
 }
 async function finish(h){
  for(let attempt=0;attempt<3;attempt++){
   const r=await cli(h,['done','--wait','300']);
   if(r.code===0){log('Normal CLI completion: '+h.id);return r;}
   // The scripted holder reads a notice, then retries exactly as the CLI asks.
   if(!r.output.includes('Superpose told this claim things you have not read yet'))throw Error(h.id+' could not finish; see '+join(dir,h.id+'-cli.log'));
  }
  throw Error(h.id+' still has unread notices after three attempts');
 }
 try{
  log('Scripted demonstration — no coding models. '+receipt.canvas);
  const seed=join(dir,'seed');prepareRuntimeFixture(seed,{reference:true});
  writeFileSync(join(seed,'src/worker.mjs'),SEED_WORKER);
  writeFileSync(join(seed,'src/receipt.mjs'),"import{runJob}from'./worker.mjs';export async function executeReceipt(job,options){const r=await runJob(job,options);return{id:r.id,state:r.state,settled:r.state!=='retry',...(r.state==='completed'?{value:r.value}:{cause:r.cause})};}\n");
  writeFileSync(join(seed,'src/queue.mjs'),"import{runJobs}from'./retry.mjs';export async function runQueue(jobs,options){const r=await runJobs(jobs,options);return{...r,counts:Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v.length]))};}\n");
  git(seed,['init','-q','-b','main']);git(seed,['add','.']);git(seed,[...author,'commit','-qm','Start the demonstration job service']);
  const baseSha=git(seed,['rev-parse','HEAD']).stdout.trim();receipt.baseSha=baseSha;
  must(await api.createLine(c.admin,'main',{sharing:'project',group:id}),'create shared line');
  const access=must(await api.lineAccess(c.admin,'main','write',1800),'line access');
  await gitAsync(seed,['push','-q',access.remote,'HEAD:main'],{env:gitAuthEnv(access.token)});
  const article=must(await api.addAssumption(c.admin,ARTICLE.statement,ARTICLE),'adopt constitution');receipt.article=article.id;
  for(const role of ROLES){
   const claim=must(await api.addClaim(c.admin,{statement:role.tasks[1],scope:role.scope,baseSha,restsOn:[]}),'create claim');
   const grant=must(await api.claim(c.agent,claim.id,'scripted-'+role.id),'take claim');
   const h={id:role.id,claim:claim.id,grant,cwd:join(dir,role.id)};holders.push(h);
   await gitAsync(dir,['clone','-q',grant.repo.remote,h.cwd],{env:gitAuthEnv(grant.git.token)});
   installGitAuth(h.cwd,grant.repo.remote,grant.git.token);
   appendFileSync(join(h.cwd,'.git/info/exclude'),'\n.superpose/\nCLAIM.md\n');
   writeClaim(h.cwd,{url:c.url,graph:id,claim:h.claim,lease:grant.token,agent:'scripted-'+role.id,statement:claim.statement,scope:role.scope,baseSha,repo:{remote:grant.repo.remote},takenAt:Date.now()});
  }
  const [worker,retry,csv]=holders;
  async function publish(rolled,baseVersion){return must(await api.request('POST','/lines/main/check-inputs',{token:c.admin,body:{baseVersion,required:['job-service'],values:runtimeInputs(runtimeData(rolled))}}),'publish current service');}
  await publish(false,0);
  await wait('initial shared product passes on service-27',s=>s.lines.find(l=>l.name==='main')?.inputCheck?.status==='passed');
  expect(true,'initial constitution passes on real Cloudflare');
  await publish(true,1);log('Published service-28: a temporary refusal now uses the legacy budget code.');
  const broken=await wait('automatic finding from the changed service',s=>s.nodes.some(n=>n.kind==='finding'&&n.runtimeEvidence?.inputVersion===2));
  const finding=broken.nodes.find(n=>n.kind==='finding'&&n.runtimeEvidence?.inputVersion===2);receipt.finding=finding.id;
  expect(finding.status==='verified'&&finding.runtimeEvidence.sha===baseSha&&finding.targets.includes(article.id),'finding identifies the exact code, article and runtime version');
  expect([worker,retry].every(h=>finding.where.includes(h.claim))&&!finding.where.includes(csv.claim),'finding routes to worker and retry, excluding CSV');
  for(const h of holders){const notices=noticesAbout(indexSnapshot(broken),h.claim).filter(n=>n.type==='claim.stale');writeFileSync(join(dir,h.id+'-notices.json'),JSON.stringify(notices,null,2));expect(h.id==='csv'?notices.length===0:notices.length>0,h.id+' receives the appropriate contradiction notices');}
  writeFileSync(join(csv.cwd,'src/report.mjs'),"import{exportCsv}from'./export.mjs';export function exportReport(result){return exportCsv([...result.completed,...result.stopped,...result.pending]);}\n");
  commit(csv,'Add an independent CSV report');
  await gitAsync(csv.cwd,['push','-q','origin','HEAD:main']);
  const pending=await wait('independent CSV passes its checks and waits for the broken line',s=>s.pushes.some(p=>p.claim===csv.claim&&p.sha===csv.sha&&p.pair?.status==='blocked'));
  expect(pending.nodes.find(n=>n.id===csv.claim)?.status==='claimed'&&!pending.nodes.some(n=>n.kind==='finding'&&n.where?.includes(csv.claim)),'CSV remains active; the gate does not falsely blame its commit');
  // Start normal completion while the shared product is still broken.
  const csvCompletion=finish(csv).then(value=>({value}),error=>({error}));
  const replan=await cli(worker,['replan','--rests-on','none']);if(replan.code!==0)throw Error('Worker could not re-plan; see its CLI log.');
  writeFileSync(join(worker.cwd,'src/worker.mjs'),REFERENCE_WORKER);commit(worker,'Keep affordable work retryable and preserve completed effects');
  await finish(worker);
  const completed=await csvCompletion;if(completed.error)throw completed.error;
  const final=await wait('repair and unchanged CSV land; current service passes',s=>[worker,csv].every(h=>s.nodes.find(n=>n.id===h.claim)?.status==='landed')&&s.lines.find(l=>l.name==='main')?.inputCheck?.status==='passed');
  expect(final.pushes.some(p=>p.claim===csv.claim&&p.sha===csv.sha&&p.pair?.status==='passed'),'automatic recheck accepts the same CSV commit after repair');
  expect(final.nodes.find(n=>n.id===finding.id)?.status==='resolved','the automatic finding remains on record and is resolved');
  const checkout=join(dir,'final');await gitAsync(dir,['clone','-q',access.remote,checkout],{env:gitAuthEnv(access.token)});
  const evaluation=evaluateRuntime(checkout);receipt.evaluation=evaluation;expect(evaluation.pass,'all 11 integrated product checks pass');
  receipt.claims=holders.map(h=>({role:h.id,id:h.claim,sha:h.sha}));receipt.sharedSha=git(checkout,['rev-parse','HEAD']).stdout.trim();receipt.pass=true;
  log('PASS actual Cloudflare detection, selective routing, repair and independent delivery.');log('Canvas: '+receipt.canvas);return receipt;
 }catch(error){receipt.pass=false;receipt.error=error.message;throw error;}
 finally{
  for(const child of children)child.kill('SIGKILL');
  for(const h of holders)await api.release(h.grant.token,h.claim).catch(()=>{});
  receipt.elapsedMs=Date.now()-started;writeFileSync(join(dir,'result.json'),JSON.stringify(receipt,null,2));log('Receipt: '+join(dir,'result.json'));
 }
}
if(import.meta.main)demo().catch(e=>{console.error(e.message);process.exitCode=1;});

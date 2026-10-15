#!/usr/bin/env bun
// No model turns. Actual Artifacts, Cloudflare checks and scoped CLI transport.
import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';import{join,resolve}from'node:path';
import {git,gitAsync,atomicWrite}from'./lib.mjs';import{prepareHostedOrigin}from'./hosted-origin.mjs';import{isolatedCodex}from'./isolated-codex.mjs';
import{prepareRuntimeFixture,ROLES,ARTICLE,writeRuntime,REFERENCE_WORKER}from'./runtime-fixture.mjs';import{RuntimeInputAdapter}from'./runtime-input-adapter.mjs';
import{credentials,must,initSeed,provisionNative,command,CLI,IMAGE,owner,apiFor,collectNotices}from'./runtime-support.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function qualifyRuntime(root){
 root=resolve(root);mkdirSync(root,{recursive:true});const{admin,agent,url}=credentials(),id=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15).toLowerCase(),graphId='runtime-qual-'+id,api=apiFor(url,graphId,admin),rows=[];
 const result={graphId,url,modelCalls:0,startedAt:Date.now(),checks:[]};const save=()=>atomicWrite(join(root,'qualification.json'),JSON.stringify(result,null,2));
 const log=(event,data={})=>{appendFileSync(join(root,'events.jsonl'),JSON.stringify({at:Date.now(),event,...data})+'\n');console.log(JSON.stringify({event,...data}));};
 const assert=(name,pass,details)=>{result.checks.push({name,pass,...(details?{details}:{})});save();if(!pass)throw Error('Qualification failed: '+name);log('passed',{name});};
 async function snapshot(){const s=must(await api.snapshot(),'qualification snapshot');atomicWrite(join(root,'snapshot.json'),JSON.stringify(s,null,2));return s;}
 async function waitFor(name,predicate,ms=180000){const until=Date.now()+ms;while(Date.now()<until){const s=await snapshot();if(predicate(s))return s;await sleep(2000);}throw Error('Qualification timeout: '+name);}
 try{
  const seed=join(root,'seed'),runtime=join(root,'runtime');prepareRuntimeFixture(seed);const baseSha=initSeed(seed);writeRuntime(runtime);
  await prepareHostedOrigin({seedCheckout:seed,url,graphId,adminToken:admin});must(await api.createLine(admin,'main',{sharing:'project',group:graphId}),'isolate qualification');const article=must(await api.addAssumption(admin,ARTICLE.statement,ARTICLE),'adopt actual public check');result.article=article.id;result.baseSha=baseSha;save();
  for(const role of ROLES){const row={...role,cwd:join(root,'work',role.id)};rows.push(row);await provisionNative({row,api,admin,agent,graphId,url,baseSha,task:role.tasks[0],transportFile:join(root,role.id+'-transport.jsonl'),initial:true});}
  const adapter=new RuntimeInputAdapter({api,admin,file:join(runtime,'current.json'),onPublish:p=>log('published',p)});await adapter.publish();
  await waitFor('initial current service passes',s=>s.lines.find(l=>l.name==='main')?.inputCheck?.status==='passed');assert('actual Cloudflare article passes initial version',true);
  writeRuntime(runtime,true);await adapter.publish();
  const failed=await waitFor('changed service automatically creates finding',s=>s.nodes.some(n=>n.kind==='finding'&&n.finder==='gate'&&n.runtimeEvidence?.inputVersion===2));
  const finding=failed.nodes.find(n=>n.kind==='finding'&&n.runtimeEvidence?.inputVersion===2);result.finding=finding.id;save();
  assert('automatic finding bound to real code, article and input version',finding.status==='verified'&&finding.runtimeEvidence.sha===baseSha&&finding.targets.includes(article.id));
  assert('affected worker and retry routed; independent CSV stays live',rows.slice(0,2).every(r=>finding.where.includes(r.claimId))&&!finding.where.includes(rows[2].claimId)&&failed.nodes.find(n=>n.id===rows[2].claimId).status==='claimed');
  // Reuse the real isolated executor with no turn/start call. A scripted CLI
  // reads the same scoped API and presents the same product notices as agents.
  for(const row of rows){row.executor=await isolatedCodex({cwd:row.cwd,gateway:row.gateway,image:IMAGE,runtimeDir:runtime});await collectNotices(api,row);const p=await command('docker',['exec',row.executor.containerName,'bun',CLI,'notices'],{timeoutMs:30000});writeFileSync(join(root,row.id+'-presented.txt'),p.stdout+p.stderr);assert(row.id+' scoped CLI presents appropriate runtime alerts',p.code===0&&(row.id==='csv'?!p.stdout.includes('RUNTIME CHECK'):p.stdout.includes('version 2')&&p.stdout.includes('STALE')&&!p.stdout.includes('Your commit alone passes')));}
  must(await api.request('POST','/lines/main/check-inputs',{token:admin,body:{baseVersion:2,required:['job-service'],values:{}}}),'publish unavailable input');
  const unavailable=await waitFor('missing input yields unavailable, not verified failure',s=>s.lines.find(l=>l.name==='main')?.inputCheck?.version===3);
  assert('missing input is a verifier error and creates no new verified finding',unavailable.lines.find(l=>l.name==='main').inputCheck.status==='error'&&unavailable.nodes.filter(n=>n.kind==='finding').length===1);
  const finish=await api.finish(rows[2].lease,rows[2].claimId);assert('missing current evidence cannot authorize completion',!finish.ok);
  // Publish the same observed service under a new version after availability returns.
  adapter.digest=null;await adapter.publish();await waitFor('available changed input remains broken',s=>s.lines.find(l=>l.name==='main')?.inputCheck?.version===4);
  const row=rows[0];must(await api.replan(row.lease,row.claimId,{restsOn:[]}),'replan scripted repair');
  writeFileSync(join(row.cwd,'src/worker.mjs'),REFERENCE_WORKER);git(row.cwd,['add','src/worker.mjs']);git(row.cwd,['-c','core.hooksPath=/dev/null',...owner,'commit','-qm','Preserve affordable work and completed effects\n\nSuperpose-Claim: '+row.claimId]);
  await gitAsync(row.cwd,['-c','core.hooksPath=/dev/null','push','-q','origin','HEAD:main']);
  // Exercise the public product CLI, including its normal notice acknowledgement.
  let submitted=false;for(let n=0;n<4;n++){const p=await command('docker',['exec',row.executor.containerName,'bun',CLI,'done','--wait','120'],{timeoutMs:150000});appendFileSync(join(root,'repair-submit.txt'),p.stdout+p.stderr);if(p.code===0){submitted=true;break;}if(!/notice|Read them|STALE|stale/i.test(p.stdout+p.stderr))break;await sleep(2000);}
  assert('ordinary scripted repair can submit with current input identity',submitted);
  const restored=await waitFor('repair lands and current line is checked green',s=>s.nodes.find(n=>n.id===row.claimId)?.status==='landed'&&s.lines.find(l=>l.name==='main')?.inputCheck?.status==='passed',240000);
  assert('current line repair resolves runtime findings and keeps the record',restored.nodes.filter(n=>n.kind==='finding'&&n.runtimeEvidence).every(n=>n.status==='resolved')&&restored.nodes.some(n=>n.id===finding.id));
  result.pass=true;result.finishedAt=Date.now();save();log('qualification-complete',{root,graphId,pass:true,modelCalls:0});return result;
 }catch(e){result.pass=false;result.error=e.message;result.finishedAt=Date.now();save();log('qualification-failed',{message:e.message,modelCalls:0});throw e;}
 finally{for(const row of rows){await row.executor?.close();await row.gateway?.close();}}
}
if(import.meta.main)await qualifyRuntime(process.argv[2]);

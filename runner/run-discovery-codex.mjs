#!/usr/bin/env bun
import{mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync}from'node:fs';import{join,resolve}from'node:path';import{createHash}from'node:crypto';
import{git,gitAsync,gitAuthEnv,atomicWrite}from'./lib.mjs';import{prepareHostedOrigin}from'./hosted-origin.mjs';import{groupGateway}from'./experiment-gateway.mjs';import{isolatedCodex}from'./isolated-codex.mjs';import{RoleBudget,startChallengeSession}from'./challenge-session.mjs';
import{ROLES,ARTICLE,LEGACY_CONTRACT,prepareDiscoveryFixture}from'./discovery-fixture.mjs';import{writeRuntime,evaluateRuntime}from'./runtime-fixture.mjs';
import{credentials,must,initSeed,provisionNative,command,REPO,CLI,IMAGE,apiFor,collectNotices,isolatedEvaluation}from'./runtime-support.mjs';
const ORDER=['codex','notes','superpose'],ROLE_MS=240000,LIVE_MS=900000,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const digest=s=>createHash('sha256').update(s).digest('hex');
export const taskPrompt=(role,arm)=>role.task+(arm==='notes'?' Shared team notes are available at /opt/team-notes.':arm==='superpose'?' This project uses Superpose. CLAIM.md and the tool reference describe your assigned claim.':'');
const pendingLanding=s=>s.nodes.some(n=>n.kind==='claim'&&n.status==='done'&&!['failed','conflict'].includes(n.landing?.status)&&!(n.landing?.status==='error'&&n.landing.attempts>=3));
export async function runDiscovery(root,qualificationFile,recoveryFile){
 const qualification=JSON.parse(readFileSync(qualificationFile)),recovery=JSON.parse(readFileSync(recoveryFile));
 if(!qualification.pass||qualification.modelCalls!==0||!recovery.pass||recovery.modelCalls!==0)throw Error('Both real no-model qualifications must pass before coding');
 const c=credentials();if(c.url!==qualification.url||!recovery.canvas.startsWith(c.url+'/'))throw Error('Qualifications must belong to the selected deployment');
 root=resolve(root);mkdirSync(root,{recursive:true});const id=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15).toLowerCase();
 const source=join(root,'source');mkdirSync(source);cpSync(join(REPO,'runner'),join(source,'runner'),{recursive:true});cpSync(join(REPO,'src'),join(source,'src'),{recursive:true});cpSync(join(REPO,'docs/experiments/2026-10-15-unverified-discovery.md'),join(source,'protocol.md'));cpSync(qualificationFile,join(root,'qualification.json'));cpSync(recoveryFile,join(root,'recovery.json'));
 const manifest={id,startedAt:Date.now(),model:'gpt-6-luna',effort:'medium',serviceTier:'default',image:IMAGE,order:ORDER,roleMs:ROLE_MS,liveMs:LIVE_MS,actions:50,estimatedUsdPerRole:.5,sourceCommit:git(REPO,['rev-parse','HEAD']).stdout.trim(),sourceHashes:Object.fromEntries(['run-discovery-codex.mjs','discovery-fixture.mjs','runtime-fixture.mjs','runtime-support.mjs','challenge-session.mjs','isolated-codex.mjs','lib.mjs','superpose.mjs'].map(f=>[f,digest(readFileSync(join(REPO,'runner',f)))])),groups:[]};
 const save=()=>atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
 const log=(event,extra={})=>{const row={at:Date.now(),event,...extra};appendFileSync(join(root,'events.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};save();
 let cancelled=false,active=[],deadline,timer;const results=[];
 const cancel=()=>{cancelled=true;for(const row of active)void row.session?.interrupt('manual').catch(()=>{});};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 async function waitFor(api,name,predicate,ms){const end=Math.min(deadline??Infinity,Date.now()+ms);while(Date.now()<end&&!cancelled){const s=must(await api.snapshot(),name);if(predicate(s))return s;await sleep(2000);}throw Error('Timed out: '+name);}
 try{for(const [index,arm]of ORDER.entries()){
  if(cancelled)break;const native=arm==='superpose',dir=join(root,'g'+(index+1)),runtime=join(dir,'runtime'),notes=join(dir,'notes'),graphId='discovery-'+id+'-g'+(index+1),api=apiFor(c.url,graphId,c.admin);
  mkdirSync(dir);writeRuntime(runtime,true);if(arm==='notes')mkdirSync(notes);
  const meta={arm,graphId,setupAt:Date.now(),prompts:ROLES.map(r=>({role:r.id,text:taskPrompt(r,arm)})),roles:[],turns:[]};manifest.groups.push(meta);save();log('group-setup',{arm,graphId});
  const rows=[];active=rows;let sharedGateway,observer,observing=false;
  try{
   const seed=join(dir,'seed'),seedFiles=prepareDiscoveryFixture(seed);meta.baseSha=initSeed(seed);meta.seedFiles=Object.fromEntries(Object.entries(seedFiles).map(([f,v])=>[f,digest(v)]));
   const origin=await prepareHostedOrigin({seedCheckout:seed,url:c.url,graphId,adminToken:c.admin});must(await api.createLine(c.admin,'main',{sharing:'project',group:graphId}),'isolate project');
   let assumption;if(native){assumption=must(await api.addAssumption(c.admin,LEGACY_CONTRACT),'legacy premise');must(await api.addAssumption(c.admin,ARTICLE.statement,ARTICLE),'prose promise');meta.assumption=assumption.id;}
   const shared=join(dir,'project');if(!native){await gitAsync(dir,['clone','-q',origin.remoteUrl,shared],{env:gitAuthEnv(origin.auth.token)});git(shared,['config','user.name','Kevin Joo']);git(shared,['config','user.email','kevinj507@gmail.com']);sharedGateway=await groupGateway({graphId,url:c.url,remotes:[{remote:origin.remoteUrl,token:origin.auth.token}],onRequest:e=>appendFileSync(join(dir,'transport.jsonl'),JSON.stringify(e)+'\n')});git(shared,['remote','set-url','origin',sharedGateway.register(origin.remoteUrl,origin.auth.token)]);}
   for(const role of ROLES){
    const row={...role,cwd:native?join(dir,role.id):shared,budget:new RoleBudget(),pendingNotices:[],lastAction:Date.now(),failures:0};row.budget.maxMs=ROLE_MS;rows.push(row);
    if(native)await provisionNative({row,api,...c,graphId,baseSha:meta.baseSha,task:role.task,transportFile:join(dir,role.id+'-transport.jsonl'),initial:true,restsOn:role.id==='csv'?[]:[assumption.id]});else row.gateway=sharedGateway;
   }
   for(const row of rows){
    row.session=await startChallengeSession({cwd:row.cwd,gateway:row.gateway,image:IMAGE,stateDir:join(dir,'state',row.id),role:row,budget:row.budget,isolatedFactory:async options=>{row.executor=await isolatedCodex({...options,runtimeDir:runtime,notesDir:arm==='notes'?notes:undefined});return row.executor;},onEvent:e=>{
     const item=e.event?.params?.item;if(e.event?.method==='item/completed'&&['commandExecution','fileChange','mcpToolCall'].includes(item?.type)){row.lastAction=Date.now();row.failures=item.type==='commandExecution'&&item.exitCode!==0?row.failures+1:0;if(row.failures===3)log('suspected-stall',{arm,role:row.id,reason:'three consecutive command failures'});}
     if(e.event?.method==='item/completed'&&item?.type==='agentMessage')log('agent-message',{arm,role:row.id,text:(item.text??'').slice(0,2000)});
    }});
    meta.roles.push({role:row.id,thread:row.session.thread,model:row.session.model,toolchain:row.session.state.toolchain,claim:row.claimId});
    const p=await command('docker',['exec',row.executor.containerName,'bash','-lc',`set -eu; test -r /opt/job-service/current.json; if touch /opt/job-service/.write-probe 2>/dev/null; then exit 1; fi; test ! -r '${root}/manifest.json'; test ! -r '/root/workspace/superpose/.env'; ${arm==='notes'?"touch /opt/team-notes/.probe; rm /opt/team-notes/.probe":"test ! -e /opt/team-notes"}`]);if(p.code!==0)throw Error('Isolation probe failed');
    const q=await command('docker',['exec',row.executor.containerName,'bun','-e',`const r=await fetch('http://127.0.0.1:${row.gateway.port}/api/graphs/other-group/snapshot');if(r.status!==403)throw Error('Other group admitted');`]);if(q.code!==0)throw Error('Gateway isolation failed');
    if(native){const status=await command('docker',['exec',row.executor.containerName,'bun',CLI,'status']);if(status.code!==0)throw Error('Native claim context unavailable');}
    log('isolation-qualified',{arm,role:row.id,modelCalls:0,runtimeReadonly:true,otherGroupDenied:true});
   }
   if(!deadline){manifest.liveStartedAt=Date.now();deadline=manifest.liveStartedAt+LIVE_MS;manifest.deadlineAt=deadline;timer=setTimeout(()=>{log('live-deadline');cancel();},LIVE_MS);}
   meta.codingStartedAt=Date.now();save();log('group-start',{arm,graphId,model:'gpt-6-luna'});
   async function observe(){
    if(observing)return;observing=true;
    try{
     if(native){
      let s=must(await api.snapshot(),'native observer');
      for(const f of s.nodes.filter(n=>n.kind==='finding'&&n.finder!=='gate'&&n.status==='unverified'&&!n.publishedTo?.includes('main'))){
       log('agent-finding-observed',{arm,finding:f.id,finder:f.finder,statement:f.statement,effect:f.effect,targets:f.targets,where:f.where,status:f.status});
       const published=must(await api.request('POST','/findings/'+f.id+'/publish',{token:c.admin,body:{lines:['main']}}),'owner sharing policy');
       if(published.status!=='unverified')throw Error('Publication unexpectedly changed verification status');
       log('owner-published-unverified',{arm,finding:f.id,status:published.status});
      }
      s=must(await api.snapshot(),'snapshot after publication');atomicWrite(join(dir,'snapshot.json'),JSON.stringify(s,null,2));
      for(const row of rows){
       const current=s.nodes.find(n=>n.id===row.claimId);if(!current?.lease)continue;
       const renewal=await api.renew(row.lease,row.claimId);if(renewal.ok&&renewal.data.git?.token)row.gateway.register(row.remote,renewal.data.git.token);
       row.pendingNotices.push(...await collectNotices(api,row));
       if(row.pendingNotices.length&&row.session.state.status==='working'){
        const notices=[...row.pendingNotices],ack=await row.session.notify(notices.map(n=>n.title+'\n'+n.text).join('\n\n'),{label:'product-notice',activeOnly:true});
        if(ack!==false){row.pendingNotices.splice(0,notices.length);log('native-notice-presented',{arm,role:row.id,claim:row.claimId,types:notices.map(n=>n.type),delivery:'active-turn'});}
       }
      }
     }
     if(Date.now()-(meta.progressAt??0)>30000){meta.progressAt=Date.now();log('progress',{arm,roles:rows.map(r=>({role:r.id,status:r.session.state.status,actions:r.budget.actions,usd:r.budget.state.estimatedCostUsd}))});}
     for(const row of rows)if(row.session.state.status==='working'&&Date.now()-row.lastAction>90000&&!row.stallReported){row.stallReported=true;log('suspected-stall',{arm,role:row.id,reason:'no completed action for90s'});}
    }catch(error){log('observer-error',{arm,message:error.message});cancel();}finally{observing=false;}
   }
   observer=setInterval(()=>void observe(),3000);
   async function turn(row,prompt,label){const r=await row.session.turn(prompt,{label});meta.turns.push({role:row.id,label,status:r.status,reason:r.reason,error:r.error?.message});save();log('role-finished',{arm,...meta.turns.at(-1)});if(r.status==='provider-error')cancel();}
   await Promise.all(rows.map(row=>turn(row,taskPrompt(row,arm),'ordinary-task')));if(cancelled)throw Error('Infrastructure or deadline stop');
   // The only follow-up allowed is an actual queued product notification to a still-held claim.
   if(native){while(observing)await sleep(30);await observe();const s=must(await api.snapshot(),'idle notification eligibility');await Promise.all(rows.filter(row=>row.pendingNotices.length&&s.nodes.find(n=>n.id===row.claimId)?.lease&&!row.budget.check()).map(async row=>{const notices=row.pendingNotices.splice(0);log('native-notice-presented',{arm,role:row.id,types:notices.map(n=>n.type),delivery:'idle-holder'});await turn(row,notices.map(n=>n.title+'\n'+n.text).join('\n\n'),'product-notice');}));}
   // A completed model turn may leave an asynchronous CLI process running.
   // Observe those already-started commands within the same role time budget
   // before scoring delivery; never issue another task to finish it for them.
   while(rows.some(r=>r.session.state.activeCommands>0)&&!cancelled){
    for(const row of rows.filter(r=>r.session.state.activeCommands>0)){
     if(row.budget.check()){log('pending-command-cutoff',{arm,role:row.id,count:row.session.state.activeCommands,reason:row.budget.check()});await row.session.close();row.session.state.activeCommands=0;}
    }
    if(rows.some(r=>r.session.state.activeCommands>0))await sleep(500);
   }
   clearInterval(observer);while(observing)await sleep(30);
   if(native)await waitFor(api,'landing settlement',s=>!pendingLanding(s),90000);
   let final=shared;if(native){final=join(dir,'final');await gitAsync(dir,['clone','-q',origin.remoteUrl,final],{env:gitAuthEnv(origin.auth.token)});atomicWrite(join(dir,'final-snapshot.json'),JSON.stringify(must(await api.snapshot(),'final snapshot'),null,2));}
   const product=evaluateRuntime(final,{execute:isolatedEvaluation(final)});atomicWrite(join(dir,'product.json'),JSON.stringify(product,null,2));
   const workspaces=rows.map(row=>({role:row.id,claim:row.claimId,head:git(row.cwd,['rev-parse','HEAD']).stdout.trim(),dirty:git(row.cwd,['status','--porcelain']).stdout,product:native?evaluateRuntime(row.cwd,{execute:isolatedEvaluation(row.cwd)}):undefined,budget:row.budget.state}));atomicWrite(join(dir,'workspaces.json'),JSON.stringify(workspaces,null,2));
   const result={arm,graphId,elapsedMs:Date.now()-meta.codingStartedAt,turns:meta.turns,product,resources:rows.map(r=>({role:r.id,...r.budget.state})),sharedSha:git(final,['rev-parse','HEAD']).stdout.trim()};results.push(result);log('group-result',{arm,elapsedMs:result.elapsedMs,pass:product.pass,checks:product.checks.map(x=>({name:x.name,pass:x.pass}))});
  }catch(error){log('group-error',{arm,message:error.message});results.push({arm,error:error.message});cancelled=true;}
  finally{clearInterval(observer);while(observing)await sleep(30);for(const row of rows)await row.session?.close().catch(error=>log('close-error',{role:row.id,message:error.message}));for(const gateway of new Set(rows.map(r=>r.gateway).filter(Boolean)))await gateway.close();for(const row of rows)if(row.lease)await api.release(row.lease,row.claimId).catch(()=>{});meta.closedAt=Date.now();save();active=[];}
 }}finally{clearTimeout(timer);process.off('SIGINT',cancel);process.off('SIGTERM',cancel);atomicWrite(join(root,'results.json'),JSON.stringify({completedAt:Date.now(),cancelled,groups:results},null,2));log('run-finished',{root,cancelled,groups:results.length});}
 return{root,cancelled,groups:results};
}
if(import.meta.main){if(process.argv.includes('--help')||process.argv.length!==5)console.log('SUPERPOSE_CONNECTION=<setup connection.json> bun runner/run-discovery-codex.mjs <evidence directory> <uncertainty qualification.json> <recovery result.json>');else if(!process.env.SUPERPOSE_CONNECTION)throw Error('Select a qualified deployment using SUPERPOSE_CONNECTION.');else await runDiscovery(...process.argv.slice(2));}

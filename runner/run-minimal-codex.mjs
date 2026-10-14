#!/usr/bin/env bun
// Observation is on the host. Coding roles receive one ordinary task turn;
// there is no candidate injection, phase prompt, prescribed journal or reset.
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync,existsSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Api,git,gitAsync,gitAuthEnv,atomicWrite,writeClaim,indexSnapshot,recordNotices,noticesAbout,readSeenSeq,advanceSeenSeq,STANDING_NOTICES} from './lib.mjs';
import {prepareHostedOrigin} from './hosted-origin.mjs';
import {groupGateway} from './experiment-gateway.mjs';
import {isolatedCodex} from './isolated-codex.mjs';
import {RoleBudget,startChallengeSession} from './challenge-session.mjs';
import {ROLES,prepareMinimalFixture,evaluateMinimal} from './minimal-fixture.mjs';

const REPO=resolve(new URL('..',import.meta.url).pathname),CLI=join(REPO,'runner/superpose.mjs');
const IMAGE='sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8';
export const ORDER=['codex','notes','superpose'];
export const RELEASE_MS=40000,ROLE_MS=300000,LIVE_MS=1200000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const owner=['-c','user.name=Kevin Joo','-c','user.email=kevinj507@gmail.com'];
const must=(r,label)=>{if(!r.ok)throw Error(label+' failed: '+r.status+' '+(r.data?.error??''));return r.data;};
export function taskPrompt(role,arm){return role.task+(arm==='notes'?' Shared team notes are available at /opt/team-notes.':arm==='superpose'?' This project uses Superpose. CLAIM.md and the tool reference describe your assigned claim.':'');}
export function updateRuntime(directory,rolled=false){
 atomicWrite(join(directory,'current.json'),JSON.stringify({revision:rolled?'service-28':'service-27',temporaryCode:rolled?'budget_limit':'capacity_limit',budget:.01})+'\n');
 const stale='2026-10-01 revision service-11: capacity=0 during maintenance; superseded by service-27.\n';
 const current=rolled?'2026-10-14 revision service-28: request pressure cost=.003 budget=.01; admission=capacity_busy; HTTP=429; retryAfterMs=1; legacy response code=budget_limit.\n':'2026-10-14 revision service-27: capacity refusals use capacity_limit; budget refusals use budget_limit.\n';
 atomicWrite(join(directory,'history.log'),stale+current);
}
export async function runMinimal({outDir,startAt=0,deadlineAt,continuationOf}={}) {
 const raw=readFileSync(join(REPO,'.env'),'utf8');const field=k=>raw.match(new RegExp('^'+k+'=(.*)$','m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'');
 const admin=field('SUPERPOSE_ADMIN_TOKEN'),agent=field('SUPERPOSE_AGENT_KEY'),url=field('SUPERPOSE_URL')??'https://superpose.kevinj507.workers.dev';
 if(!admin||!agent)throw Error('Existing Superpose credentials are required');
 const id=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15).toLowerCase();
 const root=resolve(outDir??join(process.env.BB_THREAD_STORAGE??'/root/.bb/thread-storage','superpose-handoff','minimal-'+id));mkdirSync(root,{recursive:true});
 const source=join(root,'source');mkdirSync(source);for(const file of ['run-minimal-codex.mjs','minimal-fixture.mjs','isolated-codex.mjs','challenge-session.mjs','experiment-gateway.mjs','superpose.mjs','lib.mjs'])cpSync(join(REPO,'runner',file),join(source,file));
 cpSync(join(REPO,'runner'),join(source,'runner'),{recursive:true});
 cpSync(join(REPO,'docs/experiments/2026-10-14-minimal-codex-coordination.md'),join(source,'protocol.md'));
 const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const manifest={id,root,source,startedAt:Date.now(),startAt,continuationOf,model:'gpt-6-luna',effort:'medium',serviceTier:'default',image:IMAGE,order:ORDER,releaseMs:RELEASE_MS,roleMs:ROLE_MS,liveMs:LIVE_MS,authorization:'Kevin: let’s run it; minimal Codex controls, isolated groups, same 6 luna model, short run.',sourceCommit:git(REPO,['rev-parse','HEAD']).stdout.trim(),sourceHashes:Object.fromEntries(['run-minimal-codex.mjs','minimal-fixture.mjs','isolated-codex.mjs','challenge-session.mjs','experiment-gateway.mjs','superpose.mjs','lib.mjs'].map(f=>[f,sha(join(source,f))])),groups:[]};
 const log=(event,extra={})=>{const row={at:Date.now(),event,...extra};appendFileSync(join(root,'events.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};
 const save=()=>atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));save();
 let active=[],cancelled=false;const cancel=()=>{cancelled=true;for(const row of active)void row.session?.interrupt('manual').catch(()=>{});};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const globalDeadline=deadlineAt??Date.now()+LIVE_MS;if(!Number.isFinite(globalDeadline)||globalDeadline<=Date.now())throw Error('Original live deadline has elapsed');manifest.deadlineAt=globalDeadline;save();const globalTimer=setTimeout(()=>{log('live-deadline');cancel();},globalDeadline-Date.now());
 const results=[];
 try{for(const [index,arm]of [...ORDER.entries()].slice(startAt)){
  if(cancelled||Date.now()>=globalDeadline)break;
  const dir=join(root,'g'+(index+1));mkdirSync(dir);const runtime=join(dir,'runtime'),notes=join(dir,'team-notes');mkdirSync(runtime);updateRuntime(runtime);if(arm==='notes')mkdirSync(notes);
  const graphId='minimal-'+id+'-g'+(index+1),api=new Api(url,graphId,admin),native=arm==='superpose';
  const meta={arm,graphId,startedAt:Date.now(),prompts:ROLES.map(r=>({role:r.id,text:taskPrompt(r,arm)})),roles:[]};manifest.groups.push(meta);save();
  const rows=[];active=rows;let timer,renewal,published=new Set();
  log('group-setup',{arm,graphId});
  try{
   const seed=join(dir,'seed');prepareMinimalFixture(seed);git(seed,['init','-q','-b','main']);git(seed,['add','-A']);git(seed,[...owner,'commit','-qm','Start the job service']);
   meta.seedHash=sha(join(seed,'README.md'))+sha(join(seed,'src/worker.mjs'))+sha(join(seed,'src/retry.mjs'));meta.baseSha=git(seed,['rev-parse','HEAD']).stdout.trim();
   const origin=await prepareHostedOrigin({seedCheckout:seed,url,graphId,adminToken:admin});
   must(await api.createLine(admin,'main',{sharing:'project',group:graphId}),'isolate team');
   if(native)must(await api.addAssumption(admin,'Affordable jobs complete, genuine budget refusals stop, and completed effects survive retry.',{constitution:true,check:'node --test test/runtime.test.mjs'}),'product article');
   for(const role of ROLES){
    const row={...role,cwd:join(dir,'work',role.id),budget:new RoleBudget(),lastAction:Date.now(),failures:0};row.budget.maxMs=ROLE_MS;rows.push(row);
    if(native){const c=must(await api.addClaim(admin,{statement:role.task,scope:role.scope,line:'main',restsOn:[],baseSha:meta.baseSha}),'feature claim');row.claimId=c.id;const grant=must(await api.claim(agent,c.id,'luna-'+role.id),'feature holder');row.remote=grant.repo.remote;row.gitToken=grant.git.token;row.lease=grant.token;}
    else{row.remote=origin.remoteUrl;row.gitToken=origin.auth.token;}
    mkdirSync(join(dir,'work'),{recursive:true});await gitAsync(join(dir,'work'),['clone','-q',row.remote,row.cwd],{env:gitAuthEnv(row.gitToken)});git(row.cwd,['config','user.name','Kevin Joo']);git(row.cwd,['config','user.email','kevinj507@gmail.com']);
    row.gateway=await groupGateway({graphId,url,remotes:[{remote:row.remote,token:row.gitToken}],onRequest:e=>appendFileSync(join(dir,role.id+'-transport.jsonl'),JSON.stringify(e)+'\n')});
    git(row.cwd,['remote','set-url','origin',row.gateway.register(row.remote,row.gitToken)]);
    if(native){const shared=must(await api.lineAccess(admin,'main','read',3600),'team read access');git(row.cwd,['remote','add','team',row.gateway.register(shared.remote,shared.token)]);writeClaim(row.cwd,{url:row.gateway.url,graph:graphId,claim:row.claimId,lease:row.lease,agent:'luna-'+role.id,statement:role.task,scope:role.scope,baseSha:meta.baseSha,repo:{remote:row.gateway.register(row.remote,row.gitToken)},takenAt:Date.now()});appendFileSync(join(row.cwd,'.git/info/exclude'),'\n.superpose/\nCLAIM.md\n');
     atomicWrite(join(row.cwd,'CLAIM.md'),'# Your Superpose claim\n\n'+role.task+'\n\nClaim: '+row.claimId+'\nScope: '+role.scope.join(', ')+'\n\nTeam features: '+rows.map(r=>r.id+': '+r.claimId).join('; ')+'\n\nCLI: bun '+CLI+' --help\nUse the product CLI to finish your claim. origin is your claim repository; team is the shared line. Within-project finding sharing is enabled; unverified findings remain unverified.\n');
     for(const hook of ['commit-msg','pre-push']){const path=join(row.cwd,'.git/hooks',hook);writeFileSync(path,'#!/bin/sh\nexec bun '+CLI+' hook '+hook+' "$@"\n');chmodSync(path,0o755);}
    }
   }
   if(native)for(const row of rows)appendFileSync(join(row.cwd,'CLAIM.md'),'\nAll team claims: '+rows.map(r=>r.id+': '+r.claimId).join('; ')+'\n');
   for(const row of rows){
    row.session=await startChallengeSession({cwd:row.cwd,gateway:row.gateway,image:IMAGE,stateDir:join(dir,'state',row.id),role:row,budget:row.budget,isolatedFactory:async options=>{row.executor=await isolatedCodex({...options,runtimeDir:runtime,notesDir:arm==='notes'?notes:undefined});return row.executor;},onEvent:event=>{
     const ev=event.event,item=ev?.params?.item;
     if(ev?.method==='item/completed'&&['commandExecution','fileChange','mcpToolCall'].includes(item?.type)){row.lastAction=Date.now();row.failures=item.type==='commandExecution'&&item.exitCode!==0?row.failures+1:0;if(row.failures===3)log('suspected-stall',{arm,role:row.id,reason:'three consecutive command failures'});}
     if(ev?.method==='item/completed'&&item?.type==='agentMessage')log('agent-message',{arm,role:row.id,text:(item.text??'').slice(0,1200)});
    }});
    meta.roles.push({role:row.id,thread:row.session.thread,model:row.session.model,toolchain:row.session.state.toolchain});
   }
   // Probe the actual containers, including new shared-resource boundaries,
   // before any turn. This executes tools, not model requests.
   for(const row of rows){
    const probe=`set -eu
test -r /opt/job-service/current.json
if touch /opt/job-service/.write-probe 2>/dev/null; then echo 'runtime is writable' >&2; exit 1; fi
test ! -r '${root}/source/minimal-fixture.mjs'
test ! -r '${root}/manifest.json'
test ! -r '/root/workspace/superpose/.env'
${arm==='notes'?"touch /opt/team-notes/.mount-probe; rm /opt/team-notes/.mount-probe":"test ! -e /opt/team-notes"}
printf 'isolated-resources\\n'
`;
    const p=spawnSync('docker',['exec',row.executor.containerName,'bash','-lc',probe],{encoding:'utf8',timeout:15000});if(p.status!==0)throw Error('Resource isolation failed: '+p.stderr.slice(-400));
    await new Promise((done,reject)=>{const c=spawn('docker',['exec',row.executor.containerName,'bun','-e',`const r=await fetch('http://127.0.0.1:${row.gateway.port}/api/graphs/another-group/snapshot');if(r.status!==403)throw Error('cross-group route admitted');`],{stdio:['ignore','pipe','pipe']});let err='';c.stderr.on('data',b=>err+=b);const t=setTimeout(()=>c.kill('SIGKILL'),15000);c.on('error',reject);c.on('close',code=>{clearTimeout(t);code===0?done():reject(Error('Gateway isolation probe failed '+err.slice(-300)));});});
    log('isolation-qualified',{arm,role:row.id,runtimeReadonly:true,notesMount:arm==='notes',operatorFilesHidden:true,otherGroupDenied:true,modelCalls:0});
   }
   if(cancelled||Date.now()>=globalDeadline)throw Error('Live deadline reached before model launch');
   meta.codingStartedAt=Date.now();meta.releaseAt=meta.codingStartedAt+RELEASE_MS;save();log('group-start',{arm,graphId,model:'gpt-6-luna',releaseAt:meta.releaseAt,promptCount:3});
   timer=setTimeout(()=>{updateRuntime(runtime,true);meta.releasedAt=Date.now();meta.activeAtRollout=rows.filter(r=>r.session.state.status==='working').map(r=>r.id);save();log('runtime-rollout',{arm,active:meta.activeAtRollout});},RELEASE_MS);
   let refreshing=false;
   renewal=setInterval(async()=>{if(refreshing)return;refreshing=true;try{
    if(native){const s=must(await api.snapshot(),'native observation');atomicWrite(join(dir,'snapshot.json'),JSON.stringify(s));for(const f of s.nodes.filter(n=>n.kind==='finding'&&n.status==='unverified'&&!published.has(n.id))){must(await api.request('POST','/findings/'+f.id+'/publish',{token:admin,body:{lines:['main']}}),'configured within-team sharing');published.add(f.id);log('agent-finding-published',{arm,finding:f.id});}
     for(const row of rows){const r=await api.renew(row.lease,row.claimId);if(r.ok&&r.data.git?.token)row.gateway.register(row.remote,r.data.git.token);const snap=await api.request('GET','/snapshot',{token:row.lease});if(snap.ok){const fresh=recordNotices(row.cwd,noticesAbout(indexSnapshot(snap.data),row.claimId,{afterSeq:readSeenSeq(row.cwd),types:STANDING_NOTICES}));advanceSeenSeq(row.cwd,snap.data.events.at(-1)?.seq??0);if(fresh.length&&row.session.state.status==='working'){await row.session.notify(fresh.map(n=>n.title+'\n'+n.text).join('\n\n'),{label:'product-notice'});log('native-notice-presented',{arm,role:row.id,types:fresh.map(n=>n.type)});}}}
    }
    if(Date.now()-(meta.progressAt??0)>=30000){meta.progressAt=Date.now();log('progress',{arm,roles:rows.map(r=>({role:r.id,status:r.session.state.status,actions:r.budget.actions,usd:r.budget.state.estimatedCostUsd}))});}
    for(const row of rows)if(row.session.state.status==='working'&&Date.now()-row.lastAction>90000&&!row.stallReported){row.stallReported=true;log('suspected-stall',{arm,role:row.id,reason:'no completed tool action for 90 seconds'});}
   }catch(error){log('observer-error',{arm,message:error.message});}finally{refreshing=false;}},5000);
   const turns=await Promise.all(rows.map(async row=>{const result=await row.session.turn(taskPrompt(row,arm),{label:'feature'});row.result={status:result.status,reason:result.reason,error:result.error?.message};log('role-finished',{arm,role:row.id,...row.result});if(result.status==='provider-error'){log('infrastructure-stop',{arm,role:row.id});cancel();}return {role:row.id,...row.result};}));
   if(!meta.releasedAt&&!cancelled){await sleep(Math.max(0,meta.releaseAt-Date.now())+10);}
   clearTimeout(timer);clearInterval(renewal);
   // Evaluation observes the shared line. The host never commits, merges,
   // or finishes a coding role's work on its behalf.
   if(native){const until=Math.min(globalDeadline,Date.now()+90000);while(Date.now()<until){const s=must(await api.snapshot(),'landing settlement');atomicWrite(join(dir,'settled-snapshot.json'),JSON.stringify(s));const pending=s.nodes.some(n=>n.kind==='claim'&&['landing','done'].includes(n.status)&&n.landedSha==null);if(!pending)break;await sleep(3000);}}
   const final=join(dir,'final');await gitAsync(dir,['clone','-q',origin.remoteUrl,final],{env:gitAuthEnv(origin.auth.token),timeoutMs:30000});const product=evaluateMinimal(final);atomicWrite(join(dir,'product.json'),JSON.stringify(product,null,2));
   const unsubmitted=rows.map(row=>({role:row.id,head:git(row.cwd,['rev-parse','HEAD']).stdout.trim(),dirty:git(row.cwd,['status','--porcelain']).stdout,commits:git(row.cwd,['log','--format=%H %s',meta.baseSha+'..HEAD'],{check:false}).stdout}));atomicWrite(join(dir,'workspaces.json'),JSON.stringify(unsubmitted,null,2));
   const result={arm,graphId,turns,product,sharedSha:git(final,['rev-parse','HEAD']).stdout.trim(),elapsedMs:Date.now()-meta.codingStartedAt,activeAtRollout:meta.activeAtRollout??[],resources:rows.map(r=>({role:r.id,...r.budget.state})),notes:arm==='notes'?notes:null};results.push(result);log('group-result',{arm,pass:product.pass,checks:product.checks?.map(c=>({name:c.name,pass:c.pass})),elapsedMs:result.elapsedMs});
  }catch(error){log('group-error',{arm,message:error.message});results.push({arm,error:error.message});cancelled=true;}
  finally{clearTimeout(timer);clearInterval(renewal);for(const row of rows){await row.session?.close().catch(error=>log('close-error',{arm,role:row.id,message:error.message}));await row.gateway?.close();}meta.finishedAt=Date.now();save();active=[];}
 }}finally{clearTimeout(globalTimer);process.off('SIGINT',cancel);process.off('SIGTERM',cancel);atomicWrite(join(root,'results.json'),JSON.stringify({completedAt:Date.now(),cancelled,groups:results},null,2));log('run-finished',{root,cancelled,groups:results.length});}
 return {root,cancelled,groups:results};
}
if(import.meta.main)await runMinimal({outDir:process.argv[2],...(process.argv[3]==='superpose-only'?{startAt:2,deadlineAt:Number(process.argv[4]),continuationOf:process.argv[5]}:{})});

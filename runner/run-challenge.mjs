#!/usr/bin/env bun
// Phase-controlled comparison. Private fixtures/auth stay on the host; every
// model sees only its own checkout, grants, brief and scheduled evidence.
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {Api,git,gitAuthEnv,atomicWrite,writeClaim,indexSnapshot,renderClaimMd,recordNotices,noticesAbout,readSeenSeq,advanceSeenSeq} from './lib.mjs';
import {prepareHostedOrigin} from './hosted-origin.mjs';
import {prepareChallengeFixture,snapshotFiles,digest} from './challenge-fixtures.mjs';
import {verifyChallengeEvidence} from './challenge-verifier.mjs';
import {groupGateway} from './experiment-gateway.mjs';
import {RoleBudget,startChallengeSession} from './challenge-session.mjs';

const REPO=resolve(new URL('..',import.meta.url).pathname),CLI=join(REPO,'runner/superpose.mjs');
const IMAGE='sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8';
const ORDER=[['A','git-same'],['B','superpose'],['A','git-fresh'],['B','git-fresh'],['A','superpose'],['B','git-same']];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const owner=['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Kevin Joo','-c','user.email=kevinj507@gmail.com'];
const env=Object.fromEntries(readFileSync(join(REPO,'.env'),'utf8').split('\n').map(l=>l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim().replace(/^['"]|['"]$/g,'')]));
const SERVICE_URL=env.SUPERPOSE_URL??'https://superpose.kevinj507.workers.dev';
function must(r,label){if(!r.ok)throw Error(label+' failed: '+(r.data?.error??r.status)+' '+(r.data?.message??''));return r.data;}
function initCommit(dir,message,date='2026-10-14T00:01:00Z'){
 if(!existsSync(join(dir,'.git')))git(dir,['init','-q','-b','main']);
 git(dir,['add','-A']);git(dir,[...owner,'commit','-qm',message],{env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}});
 return git(dir,['rev-parse','HEAD']).stdout.trim();
}
function externalReport(report){return{status:report.status,binding:{incident_id:report.binding.incidentId,workload_digest:report.binding.workloadDigest,code_sha:report.binding.codeSha,config_revision:report.binding.configRevision,trace_digest:report.binding.traceDigest,verifier_version:report.binding.verifierVersion},reason:report.reason,probes:report.probes.map(p=>JSON.stringify(p))};}
const shaFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function networkGit(cwd,args){return new Promise((resolve,reject)=>{const child=spawn('git',['-C',cwd,...args],{env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),120000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve({stdout,stderr}):reject(Error('Git transport failed '+code+': '+stderr.slice(-700)));});});}

export async function runChallenge({outDir,scripted=false,onlyArm,onlyWorld}={}){
 const runId=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15).toLowerCase();
 const root=resolve(outDir??join(process.env.BB_THREAD_STORAGE??'/root/.bb/thread-storage','superpose-handoff','challenge-'+runId));mkdirSync(root,{recursive:true});
 const sourceDir=join(root,'source');mkdirSync(sourceDir);
 for(const folder of ['runner','src','scenarios/job-runner'])cpSync(join(REPO,folder),join(sourceDir,folder),{recursive:true});
 cpSync(join(REPO,'docs/experiments/2026-10-14-challenged-assumption.md'),join(sourceDir,'protocol.md'));
 const manifest={runId,sourceCommit:git(REPO,['rev-parse','HEAD']).stdout.trim(),startedAt:Date.now(),scripted,model:scripted?null:'gpt-6-luna',effort:'medium',image:IMAGE,order:ORDER,source:sourceDir,protocolSha256:shaFile(join(sourceDir,'protocol.md')),authorization:'Kevin: proceed to the next experiment; controlled primary-hypothesis coverage required.',episodes:[]};
 atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
 let activeRows=[],cancelled=false;
 const log=(event,extra={})=>{const entry={at:Date.now(),event,...extra};appendFileSync(join(root,'events.jsonl'),JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));};
 const cancel=()=>{cancelled=true;for(const row of activeRows)void row.session?.interrupt('manual').catch(()=>{});};
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const outcomes=[];
 try{
  for(const [world,arm]of ORDER){
   if(cancelled)break;if(onlyArm&&arm!==onlyArm||onlyWorld&&world!==onlyWorld)continue;
   const index=manifest.episodes.length+1,episode='ep-'+String(index).padStart(2,'0'),dir=join(root,episode);mkdirSync(dir);
   const graphId=(scripted?'rehearsal-':'challenge-')+runId+'-'+episode;
   const meta={episode,world,arm,graphId,startedAt:Date.now(),phase:'setup'};manifest.episodes.push(meta);atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
   const deadline=meta.startedAt+20*60*1000,coverage={},rows=[];activeRows=rows;let renewing=false,renewTimer,progressTimer;
   const note=(event,extra={})=>log(event,{episode,world,arm,...extra});
   const api=new Api(SERVICE_URL,graphId,env.SUPERPOSE_ADMIN_TOKEN),native=arm==='superpose';
   let fixture,workingAccess,baseSha,finding,report;
   const deadlineTimer=setTimeout(()=>{note('episode-deadline');cancel();},Math.max(1,deadline-Date.now()));
   try{
    fixture=await prepareChallengeFixture({world,outDir:join(dir,'fixture')});
    const seedHash=digest(await snapshotFiles(fixture.seedDir));
    const earlier=manifest.episodes.find(e=>e!==meta&&e.world===world&&e.seedHash);
    if(earlier&&earlier.seedHash!==seedHash)throw Error('World-matched seed differs from the frozen earlier episode');meta.seedHash=seedHash;
    // Main is an incomplete owner skeleton. The inherited incident work is
    // committed separately on work, so it cannot silently become served code.
    const mainSeed=join(dir,'host/main');cpSync(fixture.seedDir,mainSeed,{recursive:true});
    atomicWrite(join(mainSeed,'src/diagnosis.mjs'),"export function diagnose(){return {cause:'unresolved',confidence:'none'};}\n");
    atomicWrite(join(mainSeed,'src/recovery.mjs'),"export function recover(){return {action:'unresolved',retry:false};} export async function runBatch(){return {completed:[],interrupted:[]};}\n");
    initCommit(mainSeed,'Preserve the owner skeleton','2026-10-14T00:00:00Z');
    await prepareHostedOrigin({seedCheckout:mainSeed,url:SERVICE_URL,graphId,adminToken:env.SUPERPOSE_ADMIN_TOKEN});
    must(await api.createLine(env.SUPERPOSE_ADMIN_TOKEN,'main',{sharing:'project',group:episode}),'isolate main');
    must(await api.createLine(env.SUPERPOSE_ADMIN_TOKEN,'work',{from:'main',sharing:'project',group:episode}),'create working line');
    workingAccess=must(await api.lineAccess(env.SUPERPOSE_ADMIN_TOKEN,'work','write',3600),'working access');
    const workSeed=join(dir,'host/work');git(join(dir,'host'),['clone','-q',workingAccess.remote,workSeed],{env:gitAuthEnv(workingAccess.token)});
    cpSync(fixture.seedDir,workSeed,{recursive:true});baseSha=initCommit(workSeed,'Preserve the provisional incident plans');
    git(workSeed,['push','-q',workingAccess.remote,'HEAD:main'],{env:gitAuthEnv(workingAccess.token)});
    meta.baseSha=baseSha;
    let p0;
    if(native){
     const a=must(await api.addAssumption(env.SUPERPOSE_ADMIN_TOKEN,'The budget guard caused incident inc-7f31. This inherited diagnosis is provisional.'),'P0');p0=a.id;
     must(await api.addAssumption(env.SUPERPOSE_ADMIN_TOKEN,'Published rates count requests once and independently completed side effects survive a revised diagnosis.',{constitution:true,check:'node --test constitution/promises.test.mjs'}),'constitution');
    }
    for(const role of fixture.roles){
     const row={...role,cwd:join(dir,'work',role.id),budget:new RoleBudget(),sessions:[],received:new Map(),completedTools:0,lastProgressAt:Date.now(),failureCount:0,baseSha,suspended:false};rows.push(row);
     let grant;
     if(native){
      const c=must(await api.addClaim(env.SUPERPOSE_ADMIN_TOKEN,{statement:role.statement,scope:role.scope,line:'work',restsOn:role.id==='export'?[]:[p0],baseSha}),'claim');row.claimId=c.id;
      grant=must(await api.claim(env.SUPERPOSE_AGENT_KEY,c.id,'luna-'+role.id),'take claim');row.lease=grant.token;row.grant=grant;
      row.remote=grant.repo.remote;row.gitToken=grant.git.token;
     }else{row.remote=workingAccess.remote;row.gitToken=workingAccess.token;row.claimId=role.id;}
     mkdirSync(join(dir,'work'),{recursive:true});git(join(dir,'work'),['clone','-q',row.remote,row.cwd],{env:gitAuthEnv(row.gitToken)});
     git(row.cwd,['config','user.name','luna-'+row.id]);git(row.cwd,['config','user.email',row.id+'@agents.superpose.invalid']);
     if(!native)git(row.cwd,['checkout','-qb','task/'+row.id]);
     appendFileSync(join(row.cwd,'.git/info/exclude'),'\n.experiment/\n.superpose/\nTASK.md\nCLAIM.md\n');
     row.context={publicPromises:fixture.publicBrief.promises,task:row.statement,scope:row.scope,acceptedCodeSha:baseSha,survivingAssumptions:row.id==='export'?[]:[{id:'P0',statement:'The budget guard caused incident inc-7f31.',status:'provisional'}],remainingWork:row.statement};
     await openSession(row,false);
    }
    for(const row of rows)atomicWrite(join(row.cwd,'TASK.md'),actorPrompt(row,'Remain provisional until the final phase; preserve other roles. '+(native?'Push origin main; use bun '+CLI+' status to read notices. Do not call done until the final phase.':'Before the final phase push only your task branch. In the final phase fetch/rebase/test and push to origin main.')));
    function publicRoleContext(row){return JSON.stringify({...row.context,interfaces:'README.md',record:row.context.checkedFacts?.record??fixture.publicBrief.report,taskBoard:rows.map(r=>({id:r.id,statement:r.statement,scope:r.scope,restsOn:r.context.survivingAssumptions.map(a=>a.id)}))},null,2);}
    function actorPrompt(row,text){return 'You are the '+row.id+' role in a shared job-runner project. Use only your own permitted files. This is a controlled inherited-work scenario; P0 is provisional, never a constitution promise. Read TASK.md and README.md. Operator files under .experiment are not product code and must not be committed. Keep independently correct accounting and ledger behavior. Do not start extra agents or access another group.\n\n'+publicRoleContext(row)+'\n\n'+text;}
    async function refresh(row){
     if(!native||row.suspended||!row.lease)return;
     const lease=row.lease,result=await api.renew(lease,row.claimId);
     if(row.suspended||row.lease!==lease)return;
     if(!result.ok){if(result.status===409)return;if(result.status===401){const s=must(await api.snapshot(),'finished holder snapshot');if(['done','landed'].includes(s.nodes.find(n=>n.id===row.claimId)?.status))return;}throw Error('lease renewal failed '+result.status);}
     if(result.data.git?.token){row.gitToken=result.data.git.token;row.gateway.register(row.remote,row.gitToken);}
     const snapshot=must(await api.request('GET','/snapshot',{token:lease}),'authorized context');
     const idx=indexSnapshot(snapshot);recordNotices(row.cwd,noticesAbout(idx,row.claimId,{afterSeq:readSeenSeq(row.cwd)}));advanceSeenSeq(row.cwd,snapshot.events.at(-1)?.seq??0);
     atomicWrite(join(row.cwd,'CLAIM.md'),renderClaimMd({claim:row.claimId,...row.context,scope:row.scope,statement:row.statement},idx,row.cwd));
    }
    async function openSession(row,fresh){
     row.gateway=await groupGateway({graphId,url:SERVICE_URL,remotes:[{remote:row.remote,token:row.gitToken}],onRequest:e=>appendFileSync(join(dir,row.id+'-transport.jsonl'),JSON.stringify(e)+'\n')});
     const proxy=row.gateway.register(row.remote,row.gitToken);git(row.cwd,['remote','set-url','origin',proxy]);
     if(native){
      writeClaim(row.cwd,{url:row.gateway.url,graph:graphId,claim:row.claimId,lease:row.lease,agent:'luna-'+row.id,statement:row.statement,scope:row.scope,baseSha:row.baseSha,repo:{remote:proxy},takenAt:Date.now()});
      for(const hook of ['commit-msg','pre-push']){const file=join(row.cwd,'.git/hooks',hook);writeFileSync(file,'#!/bin/sh\nexec bun '+CLI+' hook '+hook+' "$@"\n');chmodSync(file,0o755);}
      await refresh(row);
     }
     atomicWrite(join(row.cwd,'TASK.md'),actorPrompt(row,'Work remains in a provisional branch until the final phase. '+(native?'Push origin main; use bun '+CLI+' status to read notices. Do not call done until the final phase.':'Before the final phase push only your task branch. In the final phase fetch/rebase/test and push to origin main.')));
     if(scripted){
      const thread='scripted-'+randomUUID();row.session={thread,model:null,state:{status:'ready'},async interrupt(){},async close(){},async turn(text,{label}={}){row.received.set(label,Date.now());note('scripted-presentation',{role:row.id,label,thread});if(label==='initial')atomicWrite(join(row.cwd,'.experiment/progress.json'),JSON.stringify({position:row.id==='export'?'independent':'provisional',premise:row.id==='export'?null:'P0'}));if(label==='final'){for(const path of row.scope){const ref=join(REPO,'scenarios/job-runner/reference',basename(path));if(existsSync(ref))cpSync(ref,join(row.cwd,path));}await commitAndPush(row,true);}return{status:'completed'};}};
     }else row.session=await startChallengeSession({cwd:row.cwd,gateway:row.gateway,image:IMAGE,stateDir:join(dir,'state',row.id,String(row.sessions.length+1)),role:row,budget:row.budget,onEvent:event=>{
      if(event.kind==='user-message-received'){const text=(event.item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');for(const [label,prompt]of(row.pendingPrompts??new Map()))if(text===prompt&&!row.received.has(label)){row.received.set(label,event.at);note('presented',{role:row.id,label,thread:event.session});}}
      const ev=event.event;if(ev?.method==='item/completed'){const item=ev.params.item;if(['commandExecution','fileChange','mcpToolCall'].includes(item?.type)){row.completedTools++;row.lastProgressAt=Date.now();if(item.type==='commandExecution'&&item.exitCode!==0){row.failureCount++;note('command-failed',{role:row.id,code:item.exitCode,consecutive:row.failureCount});}else row.failureCount=0;}if(item?.type==='agentMessage')note('agent-message',{role:row.id,text:(item.text??'').slice(0,700)});}
     }});
     row.sessions.push({thread:row.session.thread,fresh,startedAt:Date.now()});note(fresh?'fresh-session':'session-ready',{role:row.id,thread:row.session.thread,model:row.session.model});
    }
    async function phaseTurn(row,text,label,{receipt=false,allowInterruption=false}={}){
     if(cancelled||Date.now()>=deadline)throw Error('Run stopped at its deadline or by operator');
     const prompt=label==='initial'?actorPrompt(row,text):text;row.pendingPrompts??=new Map();row.pendingPrompts.set(label,prompt);
     const beforeTools=row.completedTools,phaseAt=Date.now();
     const running=row.session.turn(prompt,{label});running.catch(()=>{});
     let windowStop=false;const windowTimer=label==='candidate'&&!scripted?setInterval(()=>{if(!windowStop&&(Date.now()-phaseAt>=90000||row.id==='diagnosis'&&row.completedTools-beforeTools>=5)){windowStop=true;void row.session.interrupt('manual').catch(()=>{});note('investigation-window-ended',{role:row.id,completedActions:row.completedTools-beforeTools,elapsedMs:Date.now()-phaseAt});}},100):null;
     running.then(()=>clearInterval(windowTimer),()=>clearInterval(windowTimer));
     if(receipt&&!scripted){const until=Date.now()+30000;while(!row.received.has(label)&&Date.now()<until){if(cancelled)throw Error('manual stop');await sleep(250);}if(!row.received.has(label))throw Error('Missing actual model presentation for '+row.id+'/'+label);}
     const result=await running;clearInterval(windowTimer);if(windowStop&&result.status==='interrupted'&&result.reason==='manual')return result;if(result.status!=='completed'&&!(allowInterruption&&result.status==='interrupted'&&result.reason==='contradiction'))throw Error('Role '+row.id+' '+label+' ended '+result.status+' '+(result.reason??result.error?.message??''));return result;
    }
    async function commitAndPush(row,script=false){
     const dirty=git(row.cwd,['status','--porcelain']).stdout.trim();
     if(dirty){git(row.cwd,['add','-A','--',...row.scope.filter(p=>existsSync(join(row.cwd,p)))]);git(row.cwd,['-c','core.hooksPath=/dev/null','commit','-qm','Complete '+row.id+' work'+(native?'\n\nSuperpose-Claim: '+row.claimId:'')]);}
     if(!native){await networkGit(row.cwd,['fetch','origin']);git(row.cwd,['rebase','origin/main']);}
     await networkGit(row.cwd,['-c','core.hooksPath=/dev/null','push','-q','origin','HEAD:main']);
     if(native)must(await api.notePush(row.lease,row.claimId,git(row.cwd,['rev-parse','HEAD']).stdout.trim()),'record pushed head');
    }
    renewTimer=setInterval(async()=>{if(renewing)return;renewing=true;try{await Promise.all(rows.map(refresh));}catch(error){note('renewal-warning',{message:error.message});}finally{renewing=false;}},15000);
    progressTimer=setInterval(()=>{for(const row of rows){note('progress',{role:row.id,status:row.session.state.status,actions:row.budget.actions,estimatedCostUsd:row.budget.state.estimatedCostUsd,phase:meta.phase});if(meta.phase!=='waiting-evidence'&&row.session.state.status==='working'&&(Date.now()-row.lastProgressAt>180000||row.failureCount>=3))note('suspected-stall',{role:row.id,consecutiveFailures:row.failureCount});}},60000);
    note('episode-start',{graph:SERVICE_URL+'/g/'+graphId,baseSha,seedHash});
    meta.phase='initial';
    await Promise.all(rows.map(row=>phaseTurn(row,'Read the inherited work. Record a brief provisional plan in .experiment/progress.json with position provisional/challenged/unresolved/independent and the premise it uses. Do a small amount of reversible work, commit any product changes in scope, then end this turn. More evidence and work will follow in this SAME conversation. Do not declare the entire task done yet.','initial')));
    coverage.inheritedDependencies=true;coverage.initialPositions=Object.fromEntries(rows.map(r=>[r.id,existsSync(join(r.cwd,'.experiment/progress.json'))?JSON.parse(readFileSync(join(r.cwd,'.experiment/progress.json'))):null]));
    for(const row of rows)if(native){const head=git(row.cwd,['rev-parse','HEAD']).stdout.trim();await networkGit(row.cwd,['-c','core.hooksPath=/dev/null','push','-q','origin','HEAD:main']);must(await api.notePush(row.lease,row.claimId,head),'record inherited head');}
    const affected=rows.filter(r=>r.id!=='export');
    if(native){const filed=must(await api.request('POST','/findings',{token:affected[0].lease,body:{finder:affected[0].claimId,statement:fixture.candidate.statement,effect:'contradicts',targets:[p0]}}),'file controlled candidate');finding=filed.finding.id;must(await api.request('POST','/findings/'+finding+'/publish',{token:env.SUPERPOSE_ADMIN_TOKEN,body:{lines:['work']}}),'publish candidate');const s=must(await api.snapshot(),'published snapshot');const recipients=s.events.filter(e=>e.type==='finding.shared'&&e.data.finding===finding).at(-1)?.claims??[];if(digest([...recipients].sort())!==digest(affected.map(r=>r.claimId).sort()))throw Error('Native candidate recipients differ from declared dependencies');coverage.nativeRecipients=recipients;}
    const candidateActionBaseline=affected[0].completedTools;
    coverage.candidatePublishedAt=Date.now();note('candidate-published',{finding: finding??'journal-candidate',recipients:native?affected.map(r=>r.id):rows.map(r=>r.id),status:'unverified'});
    meta.phase='investigation';
    for(const row of native?affected:rows)atomicWrite(join(row.cwd,'.experiment/candidate.json'),JSON.stringify(fixture.candidate,null,2));
    await Promise.all((native?affected:rows).map(row=>phaseTurn(row,'A significant but UNVERIFIED candidate has been shared.\n'+JSON.stringify(fixture.candidate)+'\nRead the record, state what it could change about your work, and investigate or continue/park reversible work. At most five tool actions for diagnosis; do not certify a cause from a label, this clue, or elapsed time. Historical trace is not available yet. You can preserve a provisional alternative in a local branch under this role’s unchanged budget. End this bounded turn when waiting for evidence.','candidate',{receipt:true})));
    coverage.candidatePresented=affected.every(r=>r.received.has('candidate'));coverage.independentCandidatePresented=rows.find(r=>r.id==='export').received.has('candidate');
    meta.phase='waiting-evidence';
    if(!scripted){const start=coverage.candidatePublishedAt;while(Date.now()-start<90000&&affected[0].completedTools-candidateActionBaseline<5){if(cancelled)throw Error('manual stop');await sleep(1000);}}
    if(native){const s=must(await api.snapshot(),'uncertainty snapshot');if(s.nodes.find(n=>n.id===finding)?.status!=='unverified'||s.nodes.filter(n=>affected.some(r=>r.claimId===n.id)).some(n=>n.status==='stale'))throw Error('Candidate changed truth or stopped claims before evidence');}
    coverage.uncertaintyPreserved=true;
    // A disclosed observation checkpoint holds one real tool command at a
    // safe boundary. It lets us exercise an actual running-turn interruption
    // without adding arbitrary slow work or pretending an idle turn stopped.
    const recoveryRow=rows.find(r=>r.id==='recovery'),exportRow=rows.find(r=>r.id==='export');
    let continuingRecovery,continuingExport;
    if(!scripted){
     const checkpoint="import{writeFileSync,existsSync}from'node:fs';writeFileSync('.experiment/boundary.json',JSON.stringify({enteredAt:Date.now()}));const until=Date.now()+30000;while(!existsSync('.experiment/release-boundary.json')&&Date.now()<until)await new Promise(r=>setTimeout(r,50));if(!existsSync('.experiment/release-boundary.json'))throw Error('Observation checkpoint timed out');console.log('Observation checkpoint released; inspect the latest checked record.');\n";
     atomicWrite(join(recoveryRow.cwd,'.experiment/checkpoint.mjs'),checkpoint);
     continuingRecovery=phaseTurn(recoveryRow,'Before further work run bun .experiment/checkpoint.mjs. This disclosed, bounded observation checkpoint records the running tool boundary and waits up to 30 seconds for the next record. It edits no product code. After release, read the latest record and continue your own work.','work-boundary',{allowInterruption:true});continuingRecovery.catch(()=>{});
     continuingExport=phaseTurn(exportRow,'Continue validating and completing your independent CSV feature within scope. The diagnosis dispute is not a premise of your work. End this turn when ready for final shared-product checks.','independent-progress');continuingExport.catch(()=>{});
     const until=Date.now()+30000;while(!existsSync(join(recoveryRow.cwd,'.experiment/boundary.json'))&&Date.now()<until)await sleep(200);
     if(!existsSync(join(recoveryRow.cwd,'.experiment/boundary.json'))||recoveryRow.session.state.status!=='working')throw Error('Running observation boundary was not exercised');
     coverage.runningBoundaryObserved=true;coverage.independentStateAtBoundary=exportRow.session.state.status;
    }else coverage.runningBoundaryObserved='scripted-only';
    report=await verifyChallengeEvidence(fixture.bundle);if(report.status!==(world==='A'?'refuted':'confirmed'))throw Error('Historical verifier did not qualify the scheduled world');
    atomicWrite(join(dir,'checked-evidence.json'),JSON.stringify({bundle:fixture.bundle,report},null,2));
    if(native){must(await api.request('POST','/findings/'+finding+'/external-check',{token:env.SUPERPOSE_ADMIN_TOKEN,body:externalReport(report)}),'record exact external check');const s=must(await api.snapshot(),'checked snapshot');atomicWrite(join(dir,'checked-snapshot.json'),JSON.stringify(s));const stale=s.nodes.filter(n=>n.kind==='claim'&&n.status==='stale').map(n=>n.id).sort();if(digest(stale)!==digest(world==='B'?affected.map(r=>r.claimId).sort():[]))throw Error('Native verified impact did not match affected work');coverage.nativeSelectiveImpact=true;}
    coverage.verifiedAt=Date.now();coverage.verifiedStatus=report.status;coverage.evidenceBound=report.binding;
    note('candidate-checked',{status:report.status,cause:report.cause,binding:report.binding});meta.phase='resolution';
    if(world==='B'&&arm!=='git-same'){
     await Promise.all(affected.map(async row=>{row.suspended=true;coverage[row.id+'WasRunning']=row.session.state.status==='working';row.gateway.revoke(row.remote);await row.session.interrupt('contradiction');coverage[row.id+'StopAt']=Date.now();note('old-session-stopped',{role:row.id,wasRunning:coverage[row.id+'WasRunning'],thread:row.session.thread,status:row.session.state.status});}));
    }
    for(const row of affected){
     row.suspended=true;
     atomicWrite(join(row.cwd,'.experiment/evidence.json'),JSON.stringify({record:{...fixture.bundle.workload,binding:report.binding},report,applied:fixture.bundle.applied,trace:fixture.bundle.trace,incidentFiles:fixture.bundle.incidentFiles},null,2));
     row.context.checkedFacts={report,record:{...fixture.bundle.workload,binding:report.binding}};
     if(world==='B'){
      const oldHead=git(row.cwd,['rev-parse','HEAD']).stdout.trim(),oldThread=row.session.thread,oldLease=row.lease;
      if(arm==='git-same'){row.gateway.revoke(row.remote);coverage[row.id+'WasRunning']=row.session.state.status==='working';coverage[row.id+'StopAt']=Date.now();}
      git(row.cwd,['branch','retired/P0-'+row.id,oldHead]);note('work-retired',{role:row.id,oldHead,oldThread,retainedCode:true});
      row.statement=row.id==='diagnosis'?'Resolve the exact incident from checked evidence while preserving correct accounting.':'Complete safe recovery under checked incident facts and the public budget/capacity promises.';
      row.context.task=row.statement;row.context.survivingAssumptions=[];row.context.acceptedCodeSha=oldHead;row.context.remainingWork='Resolve the task using the checked incident facts, preserving independently correct code and completing the public promises.';
      if(native){must(await api.replan(row.lease,row.claimId,{restsOn:[],statement:row.statement}),'native successor');const s=must(await api.snapshot(),'successor snapshot');coverage[row.id+'Supersedes']=s.edges.filter(e=>e.source===row.claimId&&e.purpose==='supersedes');}
      if(arm!=='git-same'){
       await row.session.close();await row.gateway.close();
       if(native){must(await api.release(row.lease,row.claimId),'release old holder');const grant=must(await api.claim(env.SUPERPOSE_AGENT_KEY,row.claimId,'luna-'+row.id+'-fresh'),'fresh holder');row.lease=grant.token;row.gitToken=grant.git.token;const old=await api.renew(oldLease,row.claimId);if(old.ok)throw Error('Old lease still valid after fresh takeover');coverage[row.id+'OldLeaseRevoked']=true;}
       row.suspended=false;await openSession(row,true);if(row.session.thread===oldThread)throw Error('Fresh treatment reused its thread');coverage[row.id+'FreshThread']=row.session.thread;
      }else{row.gateway.authorize(row.remote,row.gitToken);row.suspended=false;}
     }else row.suspended=false;
    }
    coverage.independentSessionRetained=rows.find(r=>r.id==='export').sessions.length===1;coverage.noFreshInA=world!=='A'||rows.every(r=>r.sessions.length===1);
    // Both fresh treatments receive this fixed projection, never old transcript
    // text or a reference repair. Same-conversation retains its provider history.
    const resolutionText=row=>'Checked historical evidence is available. The candidate is '+report.status+'.\n'+JSON.stringify(row.context)+'\nRead .experiment/evidence.json. Decide which of your code/plan remains justified and state your next step. Use the current declared scope and public promises; the operator supplies no repair. Work stays provisional until the final phase.';
    if(!scripted&&(world==='A'||arm==='git-same')){
     const text=resolutionText(recoveryRow);recoveryRow.pendingPrompts.set('resolution',text);await recoveryRow.session.notify(text,{label:'resolution'});
     atomicWrite(join(recoveryRow.cwd,'.experiment/release-boundary.json'),JSON.stringify({checkedAt:coverage.verifiedAt}));
    }
    await Promise.all(affected.filter(r=>scripted||r.id!=='recovery'||world==='B'&&arm!=='git-same').map(row=>phaseTurn(row,resolutionText(row),'resolution',{receipt:true})));
    if(continuingRecovery){const result=await continuingRecovery;if(world==='B'&&arm!=='git-same')coverage.recoveryInterruptAcknowledged=result.status==='interrupted'&&result.reason==='contradiction';}
    if(continuingExport)await continuingExport;
    coverage.checkedResultPresented=affected.every(r=>r.received.has('resolution'));
    const followups=[['affordable','Exercise an affordable burst under the applied capacity. Preserve accurate causes and completed effects. Finish the necessary work in your own scope; no extra budget or scope is granted.'],['over-budget','Exercise a genuinely over-budget request and an unresolved or mismatched incident record. Preserve budget stops and honest uncertainty.'],['final','Complete final reporting and CSV export under the public promises. Run tests on your own work and commit it. '+(native?'Push origin main, read status/notices, then use bun '+CLI+' done --wait 120.':'Fetch origin, rebase on origin/main, run tests, then push HEAD:main; preserve other tasks. Do not force push.')]];
    for(const[label,text]of followups){meta.phase=label;if(scripted)for(const row of rows)await phaseTurn(row,text,label);else await Promise.all(rows.map(row=>phaseTurn(row,text,label)));}
    meta.phase='settlement';
    if(native){while(Date.now()<deadline){const s=must(await api.snapshot(),'settlement');const tasks=s.nodes.filter(n=>rows.some(r=>r.claimId===n.id));if(tasks.every(n=>n.status==='landed')&&!s.lines.some(l=>l.landing)){coverage.sharedLineSettled=true;break;}for(const row of rows){const node=tasks.find(n=>n.id===row.claimId);if(scripted&&node?.status==='claimed'){const finish=await api.finish(row.lease,row.claimId);if(!finish.ok&&finish.status!==409)throw Error('Scripted finish failed '+finish.status);}}note('waiting-for-landings',{claims:tasks.map(n=>({id:n.id,status:n.status}))});await sleep(3000);}if(!coverage.sharedLineSettled)throw Error('Submitted work did not settle by run deadline');}else coverage.sharedLineSettled=true;
    for(const row of rows){const commits=git(row.cwd,['log','--format=%H','--author='+row.id+'@agents.superpose.invalid',baseSha+'..HEAD']).stdout.trim().split('\n').filter(Boolean);const outside=commits.flatMap(sha=>git(row.cwd,['show','--format=','--name-only',sha]).stdout.split('\n').filter(p=>p&&!row.scope.includes(p)));if(outside.length)throw Error('Role changed files outside scope: '+row.id+' '+outside.join(','));}
    const access=must(await api.lineAccess(env.SUPERPOSE_ADMIN_TOKEN,'work','read',600),'final read access');const final=join(dir,'final');git(dir,['clone','-q',access.remote,final],{env:gitAuthEnv(access.token)});meta.finalHead=git(final,['rev-parse','HEAD']).stdout.trim();
    const acceptance=await isolatedAcceptance(final,fixture,dir);
    const required=['inheritedDependencies','candidatePresented','uncertaintyPreserved','checkedResultPresented','independentSessionRetained','noFreshInA','sharedLineSettled','runningBoundaryObserved'];if(world==='B'&&arm!=='git-same'){required.push('diagnosisFreshThread','recoveryFreshThread');if(!scripted)required.push('recoveryInterruptAcknowledged');}if(native)required.push('nativeSelectiveImpact');
    const covered=required.every(k=>Boolean(coverage[k]));meta.endedAt=Date.now();meta.phase='complete';
    const result={...meta,coverage,coveragePass:covered,product:acceptance,roles:rows.map(r=>({id:r.id,sessions:r.sessions,budget:r.budget.state})),billingUsd:null};outcomes.push(result);atomicWrite(join(dir,'result.json'),JSON.stringify(result,null,2));atomicWrite(join(dir,'snapshot.json'),JSON.stringify(must(await api.snapshot(),'final snapshot')));
    note('episode-result',{coveragePass:covered,productPass:acceptance.pass,finalHead:meta.finalHead});
    if(!covered)throw Error('Required coordination coverage was not exercised');
   }catch(error){meta.endedAt=Date.now();meta.phase='failed';const failure={...meta,instrumentationFailure:true,message:error.message,coverage,roles:rows.map(r=>({id:r.id,sessions:r.sessions,budget:r.budget.state}))};outcomes.push(failure);atomicWrite(join(dir,'failure.json'),JSON.stringify(failure,null,2));note('BLOCKED',{message:error.message});break;}
   finally{clearTimeout(deadlineTimer);clearInterval(renewTimer);clearInterval(progressTimer);for(const row of rows){row.suspended=true;await row.session?.close().catch(()=>{});await row.gateway?.close().catch(()=>{});}activeRows=[];atomicWrite(join(root,'results.json'),JSON.stringify(outcomes,null,2));atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));}
  }
 }finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);manifest.endedAt=Date.now();atomicWrite(join(root,'manifest.json'),JSON.stringify(manifest,null,2));}
 return {root,results:outcomes};
}

async function isolatedAcceptance(checkout,fixture,dir){
 const evidence=join(dir,'evaluation-evidence');cpSync(fixture.evidenceDir,evidence,{recursive:true});
 const bundle={...fixture.bundle,privateDir:'/evidence',historicalDir:'/evidence/historical'};atomicWrite(join(evidence,'bundle.json'),JSON.stringify(bundle));
 const args=['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--tmpfs','/tmp:rw,size=32m','--mount','type=bind,src='+checkout+',dst=/workspace,readonly','--mount','type=bind,src='+join(REPO,'runner')+',dst=/checks,readonly','--mount','type=bind,src='+evidence+',dst=/evidence,readonly','--workdir','/workspace','--entrypoint','node',IMAGE,'/checks/challenge-acceptance.mjs','--checkout','/workspace','--evidence','/evidence/bundle.json'];
 const r=spawnSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:1000000});atomicWrite(join(dir,'evaluation.log'),r.stdout+'\n'+r.stderr);
 if(r.status!==0&&r.status!==1)throw Error('Independent evaluator failed: '+r.stderr.slice(-400));
 const result=JSON.parse(r.stdout);return{...result,processExitCode:r.status};
}
if(import.meta.main){const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];if(!args.includes('--scripted')&&!args.includes('--live'))throw Error('Explicit --scripted or --live required');const result=await runChallenge({scripted:args.includes('--scripted'),outDir:args.includes('--out')?value('--out'):undefined,onlyArm:args.includes('--arm')?value('--arm'):undefined,onlyWorld:args.includes('--world')?value('--world'):undefined});console.log(JSON.stringify({finished:true,root:result.root,episodes:result.results.length}));if(result.results.some(r=>r.instrumentationFailure))process.exitCode=1;}

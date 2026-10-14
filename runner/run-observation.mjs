#!/usr/bin/env bun
// Operator orchestration. Secrets/evaluators and prior groups stay on the host;
// only per-task repositories and scoped transport enter coding containers.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { OBSERVATION_SPEC, armOrder } from './experiment-spec.mjs';
import { observationAlerts, alertText } from './experiment-observer.mjs';
import { ownerResponse } from './experiment-owner-policy.mjs';
import { Api, git, gitAuthEnv, atomicWrite } from './lib.mjs';
import { evaluateContract } from '../scenarios/shop/hidden/experiment-contract.mjs';
const repo=resolve(new URL('..',import.meta.url).pathname);
const supplied=readFileSync(join(repo,'.env'),'utf8'),env={...process.env};
for(const line of supplied.split('\n')){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
const runId=new Date().toISOString().replace(/[-:.]/g,'').slice(0,15).toLowerCase();
const root=join(process.env.BB_THREAD_STORAGE??'/root/.bb/thread-storage','superpose-handoff',`live-${runId}`);mkdirSync(root,{recursive:true});
const image='sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8';
const url='https://superpose.kevinj507.workers.dev';
const log=(message)=>console.log(`[${new Date().toISOString()}] ${message}`);
const metadata={runId,startedAt:Date.now(),model:'gpt-6-luna',effort:'medium',order:armOrder(),image,root,groups:[],authorization:'Kevin instructed the operator to proceed and selected independent 6 luna sessions.'};
writeFileSync(join(root,'manifest.json'),JSON.stringify(metadata,null,2));
log(`PILOT ${root}; ${armOrder().join(' → ')}; fresh 6 luna / medium sessions, 3 slots per group.`);
let active,cancelled=false;
process.on('SIGINT',()=>{cancelled=true;active?.kill('SIGTERM');});process.on('SIGTERM',()=>{cancelled=true;active?.kill('SIGTERM');});
async function execute(args,{cwd=repo,config,timeoutMs=1800000}={}){
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env:{...env,...(config?{EXPERIMENT_CONFIG:config}:{})},stdio:['ignore','pipe','pipe']});active=child;
    const timer=setTimeout(()=>{log('Run deadline reached; stopping and preserving unfinished work.');child.kill('SIGTERM');},timeoutMs);
    createInterface({input:child.stdout}).on('line',line=>{log(line);appendFileSync(join(root,'operator.log'),line+'\n');});
    createInterface({input:child.stderr}).on('line',line=>{log(line);appendFileSync(join(root,'operator.stderr.log'),line+'\n');});
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);active=null;done(code);});
  });
}
const outcomes=[];
for(const group of armOrder()){
  if(cancelled)break;
  const dir=join(root,group),scenario=join(dir,'scenario'),work=join(dir,'work'),runs=join(dir,'runs'),state=join(dir,'state');mkdirSync(dir,{recursive:true});
  const graphId=`obs-${runId}-${group}`;
  const prepared=spawnSync(process.execPath,[join(repo,'runner/prepare-observation.mjs'),'--out',scenario,'--arm',group],{encoding:'utf8'});
  if(prepared.status!==0)throw new Error('Scenario preparation failed');
  const config=join(dir,'operator-private.json');atomicWrite(config,JSON.stringify({group,graphId,url,image,stateDir:state,adminToken:env.SUPERPOSE_ADMIN_TOKEN}),0o600);
  const plan=JSON.parse(readFileSync(join(scenario,'plan.json'),'utf8'));
  plan.lines=[{name:'main',sharing:'isolated',group}];writeFileSync(join(scenario,'plan.json'),JSON.stringify(plan,null,2));
  const manifest=JSON.parse(readFileSync(join(scenario,'operator-manifest.json'),'utf8'));
  const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  atomicWrite(join(scenario,'operator-manifest.json'),JSON.stringify({...manifest,planSha256:sha(join(scenario,'plan.json')),launcher:sha(join(repo,'runner/codex-experiment-agent.mjs')),launcherDependencies:['isolated-codex.mjs','experiment-gateway.mjs','experiment-gateway-client.mjs'].map(file=>({file,sha256:sha(join(repo,'runner',file))})),runAuthorized:true,isolationVerified:true,isolationEvidence:'launcher-preflight/output.jsonl and experiment-gateway tests; Docker network none with a scoped Unix-socket transport'}));
  const startedAt=Date.now();metadata.groups.push({group,graphId,startedAt});atomicWrite(join(root,'manifest.json'),JSON.stringify(metadata,null,2));
  const seenAlerts=new Map(),seenRequests=new Set();
  let lastProgress=0;
  const observe=()=>{
    try{
      const tasks=[];
      if(existsSync(state))for(const name of readdirSync(state)){const file=join(state,name,'state.json');if(existsSync(file))tasks.push(...JSON.parse(readFileSync(file,'utf8')).tasks);}
      const alerts=observationAlerts({tasks});
      for(const alert of alerts){const key=`${alert.task}:${alert.kind}:${alert.reason}`;if(!seenAlerts.has(key)){seenAlerts.set(key,true);log(`OBSERVE ${group}: ${alertText(alert)}`);appendFileSync(join(dir,'alerts.jsonl'),JSON.stringify({...alert,group})+'\n');}}
      if(Date.now()-lastProgress>=60000){log(`PROGRESS ${group}: ${tasks.map(t=>`${t.id} ${t.status}`).join(', ')||'preparing repositories'}`);lastProgress=Date.now();}
      const taskParent=group==='superpose'?join(work,graphId):work;
      if(existsSync(taskParent))for(const name of readdirSync(taskParent)){
        if(name.startsWith('_'))continue;
        const cwd=join(taskParent,name),file=join(cwd,'.experiment/requests.jsonl');if(!existsSync(file))continue;
        const requests=readFileSync(file,'utf8').split('\n').filter(Boolean);let used=0;
        for(let i=0;i<requests.length;i++){
          let request;try{request=JSON.parse(requests[i]);}catch{continue;}
          const key=`${name}:${i}`;
          if(seenRequests.has(key)){if(request.kind!=='blocked')used++;continue;}
          seenRequests.add(key);
          const response=ownerResponse(request,{requestsUsed:used,matchedIntent:false});
          if(request.kind==='propose'){
            // Do not decide semantic equivalence from the submitted promise ID.
            appendFileSync(join(dir,'owner-pending.jsonl'),JSON.stringify({at:Date.now(),task:name,cwd,request})+'\n');
            log(`OWNER REVIEW ${group}/${name}: proposal for ${request.promise??'unspecified promise'}; no remedy supplied.`);
            // Reserve the request; operator responds after inspecting evidence.
          }else{
            mkdirSync(join(cwd,'.experiment'),{recursive:true});appendFileSync(join(cwd,'.experiment/replies.jsonl'),JSON.stringify({at:Date.now(),task:name,index:i,...response})+'\n');
            appendFileSync(join(dir,'owner-actions.jsonl'),JSON.stringify({at:Date.now(),task:name,request,response})+'\n');
            log(`OWNER ${group}/${name}: ${response.action}`);
          }
          if(request.kind!=='blocked')used++;
        }
      }
    }catch(error){log(`Observer input unavailable: ${error.message}`);}
  };
  const interval=setInterval(observe,10000);log(`STARTING ${group}; graph ${graphId}`);
  let code;
  if(group==='superpose'){
    const planned=await execute([join(repo,'runner/plan.mjs'),scenario,'--graph',graphId,'--url',url]);
    if(planned!==0)throw new Error('Superpose planning failed');
    code=await execute([join(repo,'runner/run.mjs'),'--graph',graphId,'--url',url,'--agents','3','--model','gpt-6-luna','--effort','medium','--max-turns','50','--max-attempts','1','--budget','0.5','--skip-stale','--patience','180','--name','luna','--claude',join(repo,'runner/codex-experiment-agent.mjs'),'--work',work,'--runs',runs,'--quiet'],{config});
  }else{
    code=await execute([join(repo,'runner/plain.mjs'),scenario,'--agents','3','--model','gpt-6-luna','--effort','medium','--max-turns','50','--budget','0.5','--name','luna','--claude',join(repo,'runner/codex-experiment-agent.mjs'),'--hosted-config',config,'--work',work,'--runs',runs,'--hidden',join(repo,'runner/experiment-final.mjs'),...(group==='matched-git'?['--ask-both-ways']:[])],{config});
  }
  observe();clearInterval(interval);
  const api=new Api(url,graphId,env.SUPERPOSE_ADMIN_TOKEN);
  // done means submitted, not yet landed. Evaluate the shared product only
  // after its remaining landings complete, inside the original run deadline.
  if(group==='superpose'){
    const deadline=startedAt+OBSERVATION_SPEC.limits.runMinutes*60000;
    while(Date.now()<deadline){
      const s=await api.snapshot();
      if(s.ok && !s.data.lines.some(l=>l.landing) && s.data.nodes.filter(n=>n.kind==='claim').every(n=>['landed','superseded','open'].includes(n.status)))break;
      log('SETTLING Superpose: waiting for submitted changes to reach the shared line.');
      await new Promise(done=>setTimeout(done,10000));
    }
  }
  const snapshot=await api.snapshot();if(snapshot.ok)atomicWrite(join(dir,'snapshot.json'),JSON.stringify(snapshot.data));
  let checkout=join(work,'_main');
  if(group==='superpose'){
    const access=await api.lineAccess(env.SUPERPOSE_ADMIN_TOKEN,'main','read',600);
    if(access.ok){mkdirSync(work,{recursive:true});git(work,['clone','-q',access.data.remote,checkout],{env:gitAuthEnv(access.data.token)});}
  }
  const acceptance=existsSync(join(checkout,'package.json'))?evaluateContract(checkout):{pass:false,checks:[],error:'No final checkout'};
  const result={group,graphId,startedAt,endedAt:Date.now(),exitCode:code,acceptance,model:'gpt-6-luna',billingUsd:null};
  outcomes.push(result);atomicWrite(join(dir,'result.json'),JSON.stringify(result,null,2));atomicWrite(join(root,'results.json'),JSON.stringify(outcomes,null,2));
  log(`RESULT ${group}: product ${acceptance.pass?'PASS':'FAIL'}, runner exit ${code}; preserving every outcome.`);
}
metadata.endedAt=Date.now();atomicWrite(join(root,'manifest.json'),JSON.stringify(metadata,null,2));
log(`PILOT COMPLETE ${root}`);

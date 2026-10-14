#!/root/.bun/bin/bun
// Claude-stream compatibility at the old scheduler boundary; the actual
// session is fresh Codex, with every tool executing in its own container.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { groupGateway } from './experiment-gateway.mjs';
import { isolatedCodex } from './isolated-codex.mjs';
import { ExperimentTelemetry } from './experiment-telemetry.mjs';
import { OBSERVATION_SPEC } from './experiment-spec.mjs';
import { budgetReached, tokenCostUpperBound } from './experiment-budget.mjs';
import { atomicWrite, git, readJson } from './lib.mjs';
if(process.argv.includes('--version')){console.log('Superpose isolated Codex adapter v0.2');process.exit(0);}
const args=process.argv.slice(2),flag=(name)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
if(flag('--model')!==OBSERVATION_SPEC.agents.model||flag('--effort')!==OBSERVATION_SPEC.agents.reasoningEffort) throw new Error('Every comparison agent must use the frozen 6 luna / medium settings');
const config=readJson(process.env.EXPERIMENT_CONFIG);
if(!config) throw new Error('EXPERIMENT_CONFIG is required');
const cwd=process.cwd(),taskId=basename(cwd),out=join(config.stateDir,taskId);mkdirSync(out,{recursive:true});
const emit=(value)=>console.log(JSON.stringify(value));
const originalRemote=git(cwd,['remote','get-url','origin']).stdout.trim();
const statePath=join(cwd,'.superpose/claim.json'),sp=readJson(statePath,null);
const authFile=join(cwd,'.git/superpose-auth.config');
const token=()=>sp ? readFileSync(authFile,'utf8').match(/Authorization: Bearer ([^"\s]+)/)?.[1] : config.gitToken;
const telemetry=new ExperimentTelemetry({taskId,timeoutMs:OBSERVATION_SPEC.limits.taskMinutes*60000,onTimeline:line=>appendFileSync(join(out,'timeline.jsonl'),line)});
let session,gateway,finished=false,limitReason=null,actions=0,usage=null,timer,poller,resolveTurn;
const terminal=new Promise(done=>{resolveTurn=done;});
const persist=()=>atomicWrite(join(out,'state.json'),JSON.stringify(telemetry.state));
async function stop(reason){if(limitReason||finished)return;limitReason=reason;telemetry.requestInput({blocker:reason==='timeout'?'timeout':'budget'});persist();if(session) await session.rpc.rpc('turn/interrupt',{threadId:session.thread,turnId:activeTurn}).catch(()=>{});setTimeout(()=>resolveTurn({status:'interrupted'}),1000).unref();}
let activeTurn,notices='';
process.on('SIGTERM',()=>void stop('timeout'));
process.on('SIGINT',()=>void stop('timeout'));
try{
  gateway=await groupGateway({graphId:config.graphId,url:config.url,remotes:[{remote:originalRemote,token:token()}],onRequest:entry=>appendFileSync(join(out,'transport.jsonl'),JSON.stringify(entry)+'\n')});
  const proxyRemote=gateway.register(originalRemote,token());git(cwd,['remote','set-url','origin',proxyRemote]);
  if(sp) atomicWrite(statePath,JSON.stringify({...sp,url:gateway.url}));
  session=await isolatedCodex({cwd,gateway,image:config.image,onEvent:event=>{
    appendFileSync(join(out,'codex.jsonl'),JSON.stringify(event)+'\n');telemetry.handle(event);persist();
    emit({type:'codex',event});
    if(event.method==='turn/started')activeTurn=event.params.turn.id;
    if(event.method==='item/started'&&['commandExecution','fileChange','mcpToolCall'].includes(event.params.item?.type)){
      actions++;emit({type:'assistant',message:{content:[{type:'tool_use',name:event.params.item.type,input:{}}]}});
      if(actions>Number(flag('--max-turns')||OBSERVATION_SPEC.limits.maxTurnsPerTask))void stop('budget');
    }
    if(event.method==='thread/tokenUsage/updated'){
      usage=event.params.tokenUsage?.total ?? event.params.tokenUsage;
      if(budgetReached(usage,Number(flag('--max-budget-usd')||0.5)))void stop('budget');
    }
    if(event.method==='turn/completed'){if(limitReason)telemetry.finish('error',Date.now(),limitReason==='timeout'?'timeout':'budget');persist();finished=true;resolveTurn(event.params.turn);}
    if(event.method==='error'&&!event.params.willRetry){finished=true;resolveTurn({status:'failed'});}
  }});
  atomicWrite(join(out,'session.json'),JSON.stringify({thread:session.thread,model:session.model,effort:'medium',fresh:true,containerImage:config.image,group:config.group,billingUsd:null}));
  emit({type:'system',subtype:'init',model:session.model,session_id:session.thread});
  timer=setTimeout(()=>void stop('timeout'),OBSERVATION_SPEC.limits.taskMinutes*60000);
  poller=setInterval(()=>{
    gateway.register(originalRemote,token());
    const requests=join(cwd,'.experiment/requests.jsonl');
    if(existsSync(requests))for(const line of readFileSync(requests,'utf8').split('\n').filter(Boolean)){
      try {const r=JSON.parse(line);if(r.kind==='blocked')telemetry.requestInput({blocker:r.blocker??'unknown'});}catch{}
    }
    if(sp&&activeTurn){const text=existsSync(join(cwd,'.superpose/NOTICES.md'))?readFileSync(join(cwd,'.superpose/NOTICES.md'),'utf8'):'';
      if(text&&notices&&text!==notices)void session.rpc.rpc('turn/steer',{threadId:session.thread,expectedTurnId:activeTurn,input:[{type:'text',text:'Superpose has delivered updated notices. Read .superpose/NOTICES.md before continuing.\n'+text}]}).catch(()=>{});
      notices=text;
    }
    persist();
  },10000);
  const prompt=flag('-p');if(!prompt)throw new Error('A task brief is required');
  await session.turn(prompt.replace('Nobody will answer questions:','The published operator request channel answers requirements and proposed-rule requests without coaching.'));
  const result=await terminal;
  emit({type:'result',subtype:result.status==='completed'&&!limitReason?'success':limitReason??'agent-error',is_error:result.status!=='completed'||!!limitReason,
    num_turns:actions,total_cost_usd:null,api_equivalent_upper_usd:tokenCostUpperBound(usage),token_usage:usage,session_id:session.thread,model:session.model});
  process.exitCode=result.status==='completed'&&!limitReason?0:1;
}catch(error){emit({type:'result',subtype:'infrastructure-error',is_error:true,total_cost_usd:null,num_turns:actions,message:error.message});process.exitCode=1;}
finally{
  clearTimeout(timer);clearInterval(poller);
  if(session)await session.close();
  git(cwd,['remote','set-url','origin',originalRemote],{check:false});
  if(sp){const current=readJson(statePath,sp);atomicWrite(statePath,JSON.stringify({...current,url:sp.url}));}
  if(gateway)await gateway.close();persist();
}

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const sourceDir=dirname(new URL(import.meta.url).pathname);
export class CodexRpc {
  constructor({cwd,onEvent=()=>{}}) {
    this.pending=new Map();this.id=0;this.onEvent=onEvent;
    const env={...process.env};for(const k of Object.keys(env)) if (/^(BB_|CODEX_(SESSION|THREAD)_ID|SUPERPOSE_|CLOUDFLARE_|CF_|GRAPHTASK_)/.test(k)) delete env[k];
    this.child=spawn('codex',['app-server','--listen','stdio://','-c','memories.use_memories=false','-c','memories.generate_memories=false',
      '-c','model_context_window=64000','-c','model_auto_compact_token_limit=48000','--disable','multi_agent','--disable','plugins','--disable','apps','-c','web_search="disabled"'],{cwd,env,stdio:['pipe','pipe','pipe']});
    this.errors='';this.child.stderr.on('data',b=>{this.errors=(this.errors+b.toString()).slice(-2000);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let value;try {value=JSON.parse(line);}catch{return;}
      if(value.id!==undefined && this.pending.has(value.id)){const p=this.pending.get(value.id);this.pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(new Error(value.error.message)):p.resolve(value.result);}
      else if(value.method) this.onEvent(value);
    });
    this.child.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex session server exited'));}this.pending.clear();});
  }
  rpc(method,params,timeout=30000){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out`));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  async initialize(){await this.rpc('initialize',{clientInfo:{name:'superpose-experiment',title:'Superpose observation',version:'0.2.0'},capabilities:{experimentalApi:true}});this.child.stdin.write('{"method":"initialized"}\n');}
  close(){this.child.kill('SIGTERM');}
}

export async function isolatedCodex({cwd,gateway,image,onEvent=()=>{}}) {
  const root=mkdtempSync('/tmp/superpose-session-');const tools=join(root,'tools');mkdirSync(tools);
  for(const file of ['superpose.mjs','lib.mjs']) cpSync(join(sourceDir,file),join(tools,file));
  cpSync(join(sourceDir,'experiment-gateway-client.mjs'),join(tools,'gateway-client.mjs'));
  const bin=spawnSync('readlink',['-f',spawnSync('sh',['-c','command -v codex'],{encoding:'utf8'}).stdout.trim()],{encoding:'utf8'}).stdout.trim();
  const bun='/root/.bun/bin/bun';
  const rg=spawnSync('sh',['-c','command -v rg'],{encoding:'utf8'}).stdout.trim();
  if(!existsSync(bin)||!existsSync(bun)||!existsSync(rg)||!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Frozen Codex/Bun/rg binaries and local image are required');
  const name=`sp-task-${randomUUID()}`;let socket;
  const environmentId=`sp-${randomUUID()}`;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){if(s.upgrade(req))return;return new Response('Not found',{status:404});},
    websocket:{open(ws){socket=ws;},message(ws,msg){executor.stdin.write(`${msg}\n`);},close(){socket=null;}}});
  // Mount only this checkout, a small CLI/toolchain, and its gateway socket.
  const args=['run','--rm','-i','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--pids-limit','128','--memory','1g','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','--tmpfs','/root:rw,nosuid,nodev,size=32m',
    '--mount',`type=bind,src=${resolve(cwd)},dst=${resolve(cwd)}`,'--mount',`type=bind,src=${tools},dst=${sourceDir},readonly`,
    '--mount',`type=bind,src=${bin},dst=/opt/codex,readonly`,'--mount',`type=bind,src=${bun},dst=/opt/tools/bun,readonly`,
    '--mount',`type=bind,src=${rg},dst=/opt/tools/rg,readonly`,
    '--mount',`type=bind,src=${gateway.root},dst=/opt/experiment-gateway,readonly`,
    '--env','PATH=/opt/tools:/usr/local/bin:/usr/bin:/bin','--workdir',resolve(cwd),'--entrypoint','/bin/sh',image,
    '-c',`mkdir -p /root/.bun/bin; ln -sf /opt/tools/bun /root/.bun/bin/bun; node '${sourceDir}/gateway-client.mjs' '${gateway.port}' & exec /opt/codex exec-server --listen stdio:// --linux-sandbox-pid-namespace inherit`];
  const executor=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
  let executorErrors='';executor.stderr.on('data',b=>{executorErrors=(executorErrors+b.toString()).slice(-2000);});
  createInterface({input:executor.stdout}).on('line',line=>socket?.send(line));
  const rpc=new CodexRpc({cwd:root,onEvent});
  const close=async()=>{rpc.close();server.stop(true);spawnSync('docker',['rm','-f',name],{stdio:'ignore',timeout:10000});executor.kill();rmSync(root,{recursive:true,force:true});};
  try {
    await rpc.initialize();
    await rpc.rpc('environment/add',{environmentId,execServerUrl:`ws://127.0.0.1:${server.port}`,connectTimeoutMs:15000});
    const info=await rpc.rpc('environment/info',{environmentId});
    if(!info.cwd?.includes(resolve(cwd))) throw new Error('The executor reported a different checkout');
    const started=await rpc.rpc('thread/start',{model:'gpt-6-luna',allowProviderModelFallback:false,ephemeral:true,approvalPolicy:'never',
      sandbox:'danger-full-access',cwd:resolve(cwd),environments:[{environmentId,cwd:resolve(cwd),runtimeWorkspaceRoots:[resolve(cwd)]}],
      serviceTier:'default',config:{model_reasoning_effort:'medium',memories:{use_memories:false,generate_memories:false}},serviceName:'superpose-challenge'});
    if(started.model!=='gpt-6-luna'||started.reasoningEffort!=='medium') throw new Error('Model or effort mismatch');
    if(started.serviceTier!=='default' && started.serviceTier!=='standard') throw new Error('The experiment requires the standard service tier');
    if(started.instructionSources.some(p=>!p.startsWith(resolve(cwd)+'/'))) throw new Error('Instructions outside the task checkout were loaded');
    return {rpc,thread:started.thread.id,sessionId:started.thread.id,model:started.model,serviceTier:started.serviceTier,reasoningEffort:started.reasoningEffort,containerName:name,environmentId,close,
      async turn(prompt){return rpc.rpc('turn/start',{threadId:started.thread.id,model:'gpt-6-luna',effort:'medium',serviceTierForTurn:'default',input:[{type:'text',text:prompt}]});},
      async interrupt(turnId){if(typeof turnId!=='string'||!turnId) throw new Error('A turnId is required to interrupt the active turn');return rpc.rpc('turn/interrupt',{threadId:started.thread.id,turnId},5000);}};
  } catch(error){await close();throw new Error(`${error.message}${executorErrors ? ' (executor startup failed)' : ''}`);}
}

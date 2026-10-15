import {readFileSync,writeFileSync,mkdirSync,appendFileSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {Api,git,gitAsync,gitAuthEnv,writeClaim,atomicWrite,indexSnapshot,recordNotices,noticesAbout,readSeenSeq,advanceSeenSeq,STANDING_NOTICES} from './lib.mjs';
import {groupGateway} from './experiment-gateway.mjs';
export const REPO=resolve(new URL('..',import.meta.url).pathname),CLI=join(REPO,'runner/superpose.mjs');
export const IMAGE='sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8';
export const owner=['-c','user.name=Kevin Joo','-c','user.email=kevinj507@gmail.com'];
export function credentials(){const raw=readFileSync(join(REPO,'.env'),'utf8'),field=k=>raw.match(new RegExp('^'+k+'=(.*)$','m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'');const admin=field('SUPERPOSE_ADMIN_TOKEN'),agent=field('SUPERPOSE_AGENT_KEY'),url=field('SUPERPOSE_URL')??'https://superpose.kevinj507.workers.dev';if(!admin||!agent)throw Error('Existing Superpose credentials required');return{admin,agent,url};}
export function must(r,label){if(!r.ok)throw Error(label+' failed: '+r.status+' '+(r.data?.message??r.data?.error??''));return r.data;}
export function initSeed(dir){git(dir,['init','-q','-b','main']);git(dir,['add','-A']);git(dir,[...owner,'commit','-qm','Start the job service']);return git(dir,['rev-parse','HEAD']).stdout.trim();}
export function command(cmd,args,{cwd,timeoutMs=60000}={}){return new Promise((done,reject)=>{const p=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>p.kill('SIGKILL'),timeoutMs);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});});}
export async function provisionNative({row,api,admin,agent,graphId,url,baseSha,task,transportFile,initial=false}){
 const c=must(await api.addClaim(admin,{statement:task,scope:row.scope,line:'main',restsOn:[],baseSha}),'feature claim');
 const grant=must(await api.claim(agent,c.id,'luna-'+row.id),'feature holder');row.claimId=c.id;row.remote=grant.repo.remote;row.gitToken=grant.git.token;row.lease=grant.token;
 row.gateway??=await groupGateway({graphId,url,remotes:[],onRequest:e=>appendFileSync(transportFile,JSON.stringify(e)+'\n')});
 const remote=row.gateway.register(row.remote,row.gitToken);
 if(initial){mkdirSync(resolve(row.cwd,'..'),{recursive:true});await gitAsync(resolve(row.cwd,'..'),['clone','-q',row.remote,row.cwd],{env:gitAuthEnv(row.gitToken)});git(row.cwd,['config','user.name','Kevin Joo']);git(row.cwd,['config','user.email','kevinj507@gmail.com']);appendFileSync(join(row.cwd,'.git/info/exclude'),'\n.superpose/\nCLAIM.md\n');}
 else{if(git(row.cwd,['status','--porcelain']).stdout.trim())throw Error('Cannot provision a new claim over unfinished changes');rmSync(join(row.cwd,'.superpose'),{recursive:true,force:true});}
 git(row.cwd,['remote','set-url','origin',remote]);
 if(!initial){await gitAsync(row.cwd,['fetch','-q','origin']);git(row.cwd,['-c','core.hooksPath=/dev/null','reset','--hard','origin/main']);}
 const shared=must(await api.lineAccess(admin,'main','read',3600),'team read access');
 if(git(row.cwd,['remote']).stdout.split('\n').includes('team'))git(row.cwd,['remote','set-url','team',row.gateway.register(shared.remote,shared.token)]);else git(row.cwd,['remote','add','team',row.gateway.register(shared.remote,shared.token)]);
 writeClaim(row.cwd,{url:row.gateway.url,graph:graphId,claim:row.claimId,lease:row.lease,agent:'luna-'+row.id,statement:task,scope:row.scope,baseSha,repo:{remote},takenAt:Date.now()});
 atomicWrite(join(row.cwd,'CLAIM.md'),'# Your Superpose claim\n\n'+task+'\n\nClaim: '+row.claimId+'\nScope: '+row.scope.join(', ')+'\n\nCLI: bun '+CLI+' --help\nUse the product CLI to finish your claim. origin is your claim repository; team is the shared line. Within-project sharing is enabled; unverified findings remain unverified.\n');
 for(const hook of ['commit-msg','pre-push']){const path=join(row.cwd,'.git/hooks',hook);writeFileSync(path,'#!/bin/sh\nexec bun '+CLI+' hook '+hook+' "$@"\n');chmodSync(path,0o755);}
 row.pendingNotices=[];return c;
}
export async function collectNotices(api,row){
 const snapshot=must(await api.request('GET','/snapshot',{token:row.lease}),'scoped native observation');
 const notices=recordNotices(row.cwd,noticesAbout(indexSnapshot(snapshot),row.claimId,{afterSeq:readSeenSeq(row.cwd),types:STANDING_NOTICES}));advanceSeenSeq(row.cwd,snapshot.events.at(-1)?.seq??0);return notices;
}
export const apiFor=(url,gid,admin)=>new Api(url,gid,admin);
// Evaluation runs submitted code with just its own checkout, never the host
// credentials, other groups, or private operator files.
export function isolatedEvaluation(checkout){return({script,env={}})=>spawnSync('docker',['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,size=32m','--mount',`type=bind,src=${resolve(checkout)},dst=/project,readonly`,'--workdir','/project',...Object.entries(env).flatMap(([k,v])=>['--env',k+'='+v]),'--entrypoint','node',IMAGE,'--eval',script],{encoding:'utf8',timeout:20000});}

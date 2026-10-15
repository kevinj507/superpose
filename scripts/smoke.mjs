#!/usr/bin/env bun
// Two deterministic Git clients exercise the deployed platform. No model calls.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readConnection,ROOT} from './setup.mjs';
import {Api,git,gitAsync,gitAuthEnv} from '../runner/lib.mjs';

export async function smoke(args=process.argv.slice(2)){
 let file;
 for(let i=0;i<args.length;i++){if(args[i]==='--')continue;if(args[i]==='--connection'){file=resolve(args[++i]);continue;}if(args[i]==='--help'){console.log('bun run smoke [--connection <private setup connection.json>]');return;}throw Error('Unknown option '+args[i]);}
 const c=readConnection(file),id='smoke-'+Date.now().toString(36)+'-'+randomBytes(3).toString('hex'),api=new Api(c.url,id,c.admin),dir=join(ROOT,'.superpose/runs',id),started=Date.now();
 mkdirSync(dir,{recursive:true,mode:0o700});
 const log=s=>console.log(`+${Math.round((Date.now()-started)/1000)}s ${s}`),must=(r,why)=>{if(!r.ok)throw Error(why+': '+r.status+' '+(r.data?.message??r.data?.error??''));return r.data;};
 const identity=['-c','user.name=Superpose demo','-c','user.email=demo@superpose.invalid'];
 const checked=[];let holders=[];
 function expect(ok,name){checked.push({name,pass:!!ok});if(!ok)throw Error(name);log('PASS '+name);}
 async function wait(name,predicate,seconds=300){
  log('Waiting: '+name);const end=Date.now()+seconds*1000;let lastLog=Date.now();
  while(Date.now()<end){const s=must(await api.snapshot(),'snapshot');if(predicate(s))return s;if(Date.now()-lastLog>20000){log('Still waiting: '+name);lastLog=Date.now();}await new Promise(r=>setTimeout(r,2000));}
  throw Error('Timed out: '+name+'. Inspect '+c.url+'/g/'+id);
 }
 const receipt={graph:id,url:c.url,canvas:c.url+'/g/'+id,scripted:true,modelCalls:0,checks:checked};
 try{
  log('Cloudflare smoke check: two concurrent scripted clients. '+receipt.canvas);
  must(await api.createLine(c.admin,'main',{}),'create line');
  const access=must(await api.lineAccess(c.admin,'main','write',1800),'line access'),seed=join(dir,'seed');
  mkdirSync(join(seed,'src'),{recursive:true});mkdirSync(join(seed,'test'));
  writeFileSync(join(seed,'package.json'),JSON.stringify({name:'superpose-smoke',type:'module'}));
  writeFileSync(join(seed,'superpose.json'),JSON.stringify({check:'node --test test/*.test.mjs',timeoutSeconds:30}));
  writeFileSync(join(seed,'src/add.mjs'),'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(seed,'test/add.test.mjs'),"import{test}from'node:test';import assert from'node:assert/strict';import{add}from'../src/add.mjs';test('add',()=>assert.equal(add(2,3),5));\n");
  git(seed,['init','-q','-b','main']);git(seed,['add','.']);git(seed,[...identity,'commit','-qm','Start demo']);
  await gitAsync(seed,['push','-q',access.remote,'HEAD:main'],{env:gitAuthEnv(access.token)});
  receipt.lineRepo=access.repo;
  const tasks=[{name:'multiply',expression:'a*b',expected:6},{name:'subtract',expression:'a-b',expected:-1}];
  holders=await Promise.all(tasks.map(async t=>{const claim=must(await api.addClaim(c.admin,{statement:'Provide '+t.name,scope:['src/'+t.name+'.mjs','test/'+t.name+'.test.mjs']}),'claim');const grant=must(await api.claim(c.agent,claim.id,'scripted-'+t.name),'lease');return{...t,claim:claim.id,grant};}));
  expect(holders.length===2&&holders.every(h=>h.grant.token),'two independent clients hold concurrent claims');
  await Promise.all(holders.map(async h=>{
   const cwd=join(dir,h.name);await gitAsync(dir,['clone','-q',h.grant.repo.remote,cwd],{env:gitAuthEnv(h.grant.git.token)});
   writeFileSync(join(cwd,'src',h.name+'.mjs'),`export const ${h.name}=(a,b)=>${h.expression};\n`);
   writeFileSync(join(cwd,'test',h.name+'.test.mjs'),`import{test}from'node:test';import assert from'node:assert/strict';import{${h.name}}from'../src/${h.name}.mjs';test('${h.name}',()=>assert.equal(${h.name}(2,3),${h.expected}));\n`);
   git(cwd,['add','.']);git(cwd,[...identity,'commit','-qm','Add '+h.name+'\n\nSuperpose-Claim: '+h.claim]);h.sha=git(cwd,['rev-parse','HEAD']).stdout.trim();
   await gitAsync(cwd,['push','-q','origin','HEAD:main'],{env:gitAuthEnv(h.grant.git.token)});log('Pushed '+h.claim+' '+h.sha.slice(0,10));
  }));
  const s=await wait('Artifacts push events and Cloudflare checks',s=>holders.every(h=>s.pushes.some(p=>p.claim===h.claim&&p.sha===h.sha&&p.verdict==='checks-passed')));
  expect(holders.every(h=>s.pushes.some(p=>p.claim===h.claim&&p.sha===h.sha&&p.checks?.status==='passed')),'Cloudflare checked both exact pushed commits');
  for(const h of holders)must(await api.finish(h.grant.token,h.claim),'finish '+h.claim);
  const final=await wait('both features land on the shared line',s=>holders.every(h=>s.nodes.some(n=>n.id===h.claim&&n.status==='landed')));
  const shared=join(dir,'final');await gitAsync(dir,['clone','-q',access.remote,shared],{env:gitAuthEnv(access.token)});
  for(const h of holders){const mod=await import(pathToFileURL(join(shared,'src',h.name+'.mjs')).href);expect(mod[h.name](2,3)===h.expected,h.name+' is present in the shared product');}
  receipt.pass=true;receipt.sharedSha=git(shared,['rev-parse','HEAD']).stdout.trim();receipt.claims=holders.map(h=>({id:h.claim,sha:h.sha}));
  writeFileSync(join(dir,'snapshot.json'),JSON.stringify(final,null,2));log('PASS real Artifacts → Workflow → Container checks → shared landing');
  log('Canvas: '+receipt.canvas);return receipt;
 }catch(error){receipt.pass=false;receipt.error=error.message;throw error;}
 finally{
  for(const h of holders)await api.release(h.grant.token,h.claim).catch(()=>{});
  receipt.elapsedMs=Date.now()-started;writeFileSync(join(dir,'result.json'),JSON.stringify(receipt,null,2));
  log('Receipt: '+join(dir,'result.json'));
 }
}
if(import.meta.main)smoke().catch(e=>{console.error(e.message);process.exitCode=1;});

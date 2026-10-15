#!/usr/bin/env bun
// No coding turns. Qualify actual uncertain publication and isolated presentation.
import{mkdirSync,writeFileSync,appendFileSync}from'node:fs';import{join,resolve}from'node:path';
import{git,gitAsync}from'./lib.mjs';
import{prepareDiscoveryFixture,ROLES,ARTICLE,LEGACY_CONTRACT}from'./discovery-fixture.mjs';
import{writeRuntime}from'./runtime-fixture.mjs';import{prepareHostedOrigin}from'./hosted-origin.mjs';import{isolatedCodex}from'./isolated-codex.mjs';
import{credentials,must,initSeed,provisionNative,command,CLI,IMAGE,apiFor,collectNotices}from'./runtime-support.mjs';
export async function qualifyDiscovery(root){
 root=resolve(root);mkdirSync(root,{recursive:true});const c=credentials(),graphId='discovery-qual-'+Date.now().toString(36),api=apiFor(c.url,graphId,c.admin),rows=[];
 const result={graphId,url:c.url,modelCalls:0,startedAt:Date.now(),checks:[]};
 const save=()=>writeFileSync(join(root,'qualification.json'),JSON.stringify(result,null,2));
 const check=(name,pass)=>{result.checks.push({name,pass:!!pass});save();if(!pass)throw Error(name);console.log('PASS '+name);};
 try{
  const seed=join(root,'seed'),runtime=join(root,'runtime');prepareDiscoveryFixture(seed);const baseSha=initSeed(seed);writeRuntime(runtime,true);
  await prepareHostedOrigin({seedCheckout:seed,url:c.url,graphId,adminToken:c.admin});
  must(await api.createLine(c.admin,'main',{sharing:'project',group:graphId}),'sharing policy');
  const assumption=must(await api.addAssumption(c.admin,LEGACY_CONTRACT),'legacy contract');
  const article=must(await api.addAssumption(c.admin,ARTICLE.statement,ARTICLE),'prose article');
  for(const role of ROLES){const row={...role,cwd:join(root,role.id)};rows.push(row);await provisionNative({row,api,...c,graphId,baseSha,task:role.task,transportFile:join(root,role.id+'-transport.jsonl'),initial:true,restsOn:role.id==='csv'?[]:[assumption.id]});}
  const candidate=must(await api.finding(rows[0].lease,{finder:rows[0].claimId,statement:'A current temporary capacity refusal uses budget_limit with HTTP 429 and retryAfterMs; treating every such code as a spending refusal may discard affordable work.',effect:'contradicts',targets:[assumption.id]}),'candidate').finding;
  check('candidate remains unverified',candidate.status==='unverified');
  check('candidate stays local before owner publication',(await collectNotices(api,rows[1])).every(n=>!['local.doubt','finding.shared'].includes(n.type)));
  const publish=must(await api.request('POST','/findings/'+candidate.id+'/publish',{token:c.admin,body:{lines:['main']}}),'owner publishes');
  check('publication preserves uncertainty',publish.status==='unverified');
  for(const row of rows){
   row.executor=await isolatedCodex({cwd:row.cwd,gateway:row.gateway,image:IMAGE,runtimeDir:runtime});
   const probe=await command('docker',['exec',row.executor.containerName,'bash','-lc',`set -eu; test -r /opt/job-service/current.json; test ! -r '${root}/qualification.json'; test ! -r '/root/workspace/superpose/.env'; if touch /opt/job-service/.write-probe 2>/dev/null; then exit 1; fi`]);check(row.id+' executor cannot read operator files or modify shared runtime',probe.code===0);
   const denied=await command('docker',['exec',row.executor.containerName,'bun','-e',`const r=await fetch('http://127.0.0.1:${row.gateway.port}/api/graphs/other-group/snapshot');if(r.status!==403)throw Error('other group admitted');`]);check(row.id+' other-group API is denied',denied.code===0);
   await collectNotices(api,row);
   const shown=await command('docker',['exec',row.executor.containerName,'bun',CLI,'notices']);writeFileSync(join(root,row.id+'-presented.txt'),shown.stdout+shown.stderr);
   check(row.id+' actual scoped CLI presents the appropriate uncertainty',shown.code===0&&(row.id==='retry'?shown.stdout.includes('not yet verified')&&!shown.stdout.includes('STALE'):row.id==='csv'?!shown.stdout.includes(candidate.id):true));
  }
  const snapshot=must(await api.snapshot(),'snapshot');writeFileSync(join(root,'snapshot.json'),JSON.stringify(snapshot,null,2));
  check('uncertain publication invalidates no claim',rows.every(r=>snapshot.nodes.find(n=>n.id===r.claimId)?.status==='claimed'));
  check('prose promise has no executable checker',!article.check&&!snapshot.nodes.some(n=>n.kind==='finding'&&n.finder==='gate'));
  must(await api.refute(c.admin,candidate.id),'refute qualification candidate');
  const refuted=must(await api.snapshot(),'refuted snapshot');check('refutation keeps existing holders and branches',rows.every(r=>{const before=snapshot.nodes.find(n=>n.id===r.claimId),after=refuted.nodes.find(n=>n.id===r.claimId);return after?.status==='claimed'&&JSON.stringify(after.lease)===JSON.stringify(before.lease)&&after.headSha===before.headSha;}));
  // Exercise the complete prose-only lifecycle, including the two gaps found
  // by the real agents: revising a live assumption and completing without a
  // nonexistent executable-constitution job.
  const revised=await command('docker',['exec',rows[0].executor.containerName,'bun',CLI,'replan','--rests-on','none']);
  check('a live holder can revise its own premise without verification',revised.code===0);
  for(const row of rows){
   const file=row.id==='worker'?'src/worker.mjs':row.id==='retry'?'src/retry.mjs':'src/export.mjs';
   appendFileSync(join(row.cwd,file),'\n// Scripted qualification: this scoped module was reviewed.\n');
   git(row.cwd,['add',file]);git(row.cwd,['-c','core.hooksPath=/dev/null','commit','-qm','Record scoped qualification review\n\nSuperpose-Claim: '+row.claimId]);
   await gitAsync(row.cwd,['push','-q','origin','HEAD:main']);
  }
  await Promise.all(rows.map(async row=>{
   const began=Date.now();let completed=false;
   for(let i=0;i<3;i++){
    const r=await command('docker',['exec',row.executor.containerName,'bun',CLI,'done','--wait','60'],{timeoutMs:90000});
    appendFileSync(join(root,row.id+'-completion.txt'),r.stdout+r.stderr);
    if(r.code===0){completed=true;break;}
    if(!r.stdout.concat(r.stderr).includes('Superpose told this claim things you have not read yet'))break;
   }
   check(row.id+' ordinary completion skips absent executable checks',completed&&Date.now()-began<90000);
  }));
  let landed;const end=Date.now()+180000;
  while(Date.now()<end){landed=must(await api.snapshot(),'landing');if(rows.every(r=>landed.nodes.find(n=>n.id===r.claimId)?.status==='landed'))break;await new Promise(r=>setTimeout(r,2000));}
  writeFileSync(join(root,'landed-snapshot.json'),JSON.stringify(landed,null,2));
  check('all three prose-only claims land through their normal CLI',rows.every(r=>landed.nodes.find(n=>n.id===r.claimId)?.status==='landed'));
  result.pass=true;return result;
 }catch(error){result.pass=false;result.error=error.message;throw error;}
 finally{for(const row of rows){await row.executor?.close();await row.gateway?.close();if(row.lease)await api.release(row.lease,row.claimId).catch(()=>{});}result.finishedAt=Date.now();save();}
}
if(import.meta.main){
 if(!process.argv[2]||process.argv.includes('--help'))console.log('SUPERPOSE_CONNECTION=<setup connection.json> bun runner/qualify-discovery.mjs <evidence directory>');
 else if(!process.env.SUPERPOSE_CONNECTION)throw Error('Select the test deployment with SUPERPOSE_CONNECTION before qualification.');
 else await qualifyDiscovery(process.argv[2]);
}

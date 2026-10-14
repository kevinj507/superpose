import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {digest} from './challenge-fixtures.mjs';
import {git} from './lib.mjs';
const unknown=(binding,reason,probes=[])=>({status:'inconclusive',cause:'unresolved',binding:binding??null,reason,probes});
function execute(source,...args){return vm.runInNewContext(source+'\nmodule.exports(...args)',{module:{exports:null},args:structuredClone(args)},{timeout:1000});}
export async function verifyChallengeEvidence(bundle){
 const b=bundle?.binding;
 if(!b||!bundle.workload||!bundle.applied||!bundle.trace||!bundle.incidentFiles||!bundle.historicalDir)return unknown(b,'Missing captured incident inputs');
 const probes=[];const check=(name,pass)=>{probes.push({name,pass});return pass;};
 try{
 const released=JSON.parse(await readFile(bundle.privateDir+'/release.json','utf8'));
 const captured=Object.fromEntries(Object.keys(bundle.incidentFiles).map(p=>[p,git(bundle.historicalDir,['show',b.codeSha+':'+p]).stdout]));
 const checks=[check('released-identities',digest(released)===digest({binding:b,workload:bundle.workload,applied:bundle.applied,trace:bundle.trace,incidentFiles:bundle.incidentFiles})),check('incident',b.incidentId===bundle.workload.incidentId&&b.incidentId===bundle.trace.incidentId),check('workload',b.workloadDigest===digest(bundle.workload)),check('configuration',b.configRevision===bundle.applied.revision&&bundle.trace.appliedRevision===bundle.applied.revision),check('trace',b.traceDigest===digest(bundle.trace)),check('code',/^[a-f0-9]{40}$/.test(b.codeSha)&&b.codeSha===bundle.trace.codeSha&&digest(captured)===digest(bundle.incidentFiles)),check('verifier',b.verifierVersion==='cause-challenge-v1.1')];
 if(checks.some(x=>!x))return unknown(b,'Identity, revision, captured source or digest mismatch',probes);
 const cost=execute(captured['guard.cjs'],bundle.workload),capacity=execute(captured['machine.cjs'],bundle.workload,bundle.applied),budget=cost>bundle.applied.budget;
 probes.push({name:'recorded-code-replay',pass:true,guardCost:cost,budgetLimit:bundle.applied.budget,capacityRefusal:capacity});
 const capacityRemoved={...bundle.applied,capacity:bundle.workload.jobs.length};const budgetRemoved={...bundle.applied,budget:Number.MAX_VALUE};
 const budgetOnly=execute(captured['guard.cjs'],bundle.workload)>capacityRemoved.budget;
 const capacityOnly=execute(captured['machine.cjs'],bundle.workload,budgetRemoved);
 probes.push({name:'isolate-budget-with-capacity-removed',pass:budgetOnly===budget,cause:budgetOnly?'budget_limit':null},{name:'isolate-capacity-with-budget-removed',pass:capacityOnly===capacity,cause:capacityOnly?'capacity_limit':null});
 if(bundle.simultaneousFaults||bundle.ambiguousReplay||budget===capacity)return unknown(b,'Replay does not isolate one cause',probes);
 if(digest(bundle.trace.stopped)!==digest(bundle.workload.jobs.map(j=>j.id)))return unknown(b,'Recorded stops do not match replay',probes);
 const cause=budget?'budget_limit':'capacity_limit';
 return{status:capacity?'confirmed':'refuted',cause,binding:{...b},checked:true,reason:capacity?'Captured code and applied revision isolate capacity refusal while recorded guard cost is within budget.':'Captured code isolates inflated cost accounting; the capacity clue belongs to a different applied revision.',probes};
 }catch(error){return unknown(b,'Captured replay could not complete: '+error.message,probes);}
}

import {completeOnce} from './ledger.mjs';
// Inherited budget-only incident policy relies on provisional P0.
export function recover(interruption,retry){if(interruption.cause==='budget_limit')return{action:'stop',retry:false};return retry(interruption);}
export async function runBatch(jobs,{budget,capacity,effects=new Map()}){
 const completed=[],interrupted=[];let spend=0;
 for(const job of jobs){if(effects.has(job.id)){completed.push({...job,state:'complete',reused:true});continue;}if(spend+job.cost>budget||jobs.length>capacity){interrupted.push({id:job.id,cause:'budget_limit'});continue;}spend+=job.cost;completeOnce(effects,job.id);completed.push({...job,state:'complete',reused:false});}
 return{completed,interrupted};
}

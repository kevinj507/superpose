import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {prepareDiscoveryFixture,ARTICLE} from '../runner/discovery-fixture.mjs';
import {REFERENCE_WORKER,REFERENCE_RETRY,evaluateRuntime} from '../runner/runtime-fixture.mjs';
import {REFERENCE_CSV} from '../runner/minimal-fixture.mjs';
it('leaves discovery to the agents and rejects a broken product while accepting a complete repair',()=>{
 const dir=mkdtempSync(join(tmpdir(),'discovery-fixture-'));
 try{
  prepareDiscoveryFixture(dir);
  expect(ARTICLE.check).toBeUndefined();expect(existsSync(join(dir,'constitution/runtime.test.mjs'))).toBe(false);
  expect(evaluateRuntime(dir).pass).toBe(false);
  writeFileSync(join(dir,'src/worker.mjs'),REFERENCE_WORKER);writeFileSync(join(dir,'src/retry.mjs'),REFERENCE_RETRY);writeFileSync(join(dir,'src/export.mjs'),REFERENCE_CSV);
  writeFileSync(join(dir,'src/report.mjs'),"import{exportCsv}from'./export.mjs';export const exportReport=r=>exportCsv([...r.completed,...r.stopped,...r.pending]);");
  writeFileSync(join(dir,'src/queue.mjs'),"import{runJobs}from'./retry.mjs';export async function runQueue(j,o){const r=await runJobs(j,o);return{...r,counts:Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v.length]))};}");
  expect(evaluateRuntime(dir).pass).toBe(true);
  writeFileSync(join(dir,'src/worker.mjs'),"export async function runJob(job){return {...job,state:'completed'};}");
  expect(evaluateRuntime(dir).pass).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

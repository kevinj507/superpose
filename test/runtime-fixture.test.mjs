import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {prepareRuntimeFixture,runtimeData,runtimeInputs,REFERENCE_WORKER,REFERENCE_RETRY} from '../runner/runtime-fixture.mjs';
it('the public adopted check sees both declared versions, rejects bad repairs and cannot fall back',()=>{
 const dir=mkdtempSync(join(tmpdir(),'runtime-fixture-'));try{
  prepareRuntimeFixture(dir);const run=data=>spawnSync(process.execPath,['--test','constitution/runtime.test.mjs'],{cwd:dir,encoding:'utf8',env:{...process.env,SUPERPOSE_CHECK_INPUTS:JSON.stringify({version:1,required:['job-service'],values:data?runtimeInputs(data):{}})}});
  expect(run(runtimeData()).status).toBe(0);expect(run(runtimeData(true)).status).not.toBe(0);expect(run(null).status).not.toBe(0);
  writeFileSync(join(dir,'src/worker.mjs'),REFERENCE_WORKER);writeFileSync(join(dir,'src/retry.mjs'),REFERENCE_RETRY);
  expect(run(runtimeData()).status).toBe(0);expect(run(runtimeData(true)).status).toBe(0);
  writeFileSync(join(dir,'src/worker.mjs'),"export async function runJob(job){return {...job,state:'completed'};}\n");expect(run(runtimeData(true)).status).not.toBe(0);
  writeFileSync(join(dir,'src/worker.mjs'),"export async function runJob(job){return {...job,state:'stopped',cause:'budget'};}\n");expect(run(runtimeData(true)).status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import {test,expect,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROLES,prepareMinimalFixture,evaluateMinimal,REFERENCE_WORKER,REFERENCE_RETRY} from '../runner/minimal-fixture.mjs';
import {taskPrompt,updateRuntime,RELEASE_MS,ROLE_MS,LIVE_MS} from '../runner/run-minimal-codex.mjs';
import {scopesOverlap} from '../src/core/scope.ts';
const roots=[];const fixture=reference=>{const dir=mkdtempSync(join(tmpdir(),'minimal-qualification-'));roots.push(dir);prepareMinimalFixture(dir,{reference});return dir;};
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
test('reference satisfies both service revisions while the inherited implementation exposes the intended gaps',()=>{
 const good=evaluateMinimal(fixture(true));expect(good.pass).toBe(true);
 const seed=evaluateMinimal(fixture(false));expect(seed.pass).toBe(false);
 expect(seed.checks.find(c=>c.name==='initial-affordable-completion').pass).toBe(true);
 expect(seed.checks.find(c=>c.name==='rolled-affordable-completion').pass).toBe(false);
});
test('independent probes reject dropped jobs, repeated effects, bypassed budgets and corrupt CSV',()=>{
 for(const [file,content,check]of [
  ['src/retry.mjs',REFERENCE_RETRY.replace("for(const job of jobs){","for(const job of jobs.filter(j=>j.id!=='pressure')){"),'rolled-affordable-completion'],
  ['src/worker.mjs',REFERENCE_WORKER.replace('if(effects.has(job.id))','if(false)'),'effects-execute-once'],
  ['src/worker.mjs',REFERENCE_WORKER.replace('if(job.cost>budget)','if(false)'),'budget-prevents-effects'],
  ['src/export.mjs',"export function exportCsv(){return ''}\n",'exact-csv'],
 ]){const dir=fixture(true);writeFileSync(join(dir,file),content);const result=evaluateMinimal(dir);expect(result.pass).toBe(false);expect(result.checks.find(c=>c.name===check).pass).toBe(false);}
});
test('baseline has only a feature request, and runtime release contains no model-directed coordination',()=>{
 for(const role of ROLES){const prompt=taskPrompt(role,'codex');expect(prompt).toBe(role.task);expect(prompt).not.toMatch(/experiment|progress|journal|assumptions?|candidate|investigate|checkpoint|replan|reset|rollout|\.json/i);}
 const dir=mkdtempSync(join(tmpdir(),'minimal-runtime-'));roots.push(dir);updateRuntime(dir);expect(JSON.parse(readFileSync(join(dir,'current.json'))).temporaryCode).toBe('capacity_limit');updateRuntime(dir,true);expect(JSON.parse(readFileSync(join(dir,'current.json'))).temporaryCode).toBe('budget_limit');
 expect(RELEASE_MS).toBe(40000);expect(ROLE_MS).toBe(300000);expect(LIVE_MS).toBe(1200000);
});
test('native roles can be assigned in parallel under the existing conservative scope policy',()=>{
 for(let i=0;i<ROLES.length;i++)for(let j=i+1;j<ROLES.length;j++)expect(scopesOverlap(ROLES[i].scope,ROLES[j].scope)).toBe(false);
});

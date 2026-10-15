import{it,expect}from'vitest';import{mkdtempSync,readFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{ROLES,prepareRuntimeFixture}from'../runner/runtime-fixture.mjs';import{taskPrompt}from'../runner/run-runtime-codex.mjs';
it('the vanilla control receives only ordinary feature requests, with no coordination treatment',()=>{
 for(const role of ROLES)for(const wave of[0,1]){expect(taskPrompt(role,'codex',wave)).toBe(role.tasks[wave]);expect(taskPrompt(role,'notes',wave)).toBe(role.tasks[wave]+' Shared team notes are available at /opt/team-notes.');}
 const dir=mkdtempSync(join(tmpdir(),'runtime-protocol-'));try{prepareRuntimeFixture(dir);const readme=readFileSync(join(dir,'README.md'),'utf8');expect(readme).not.toMatch(/Deliver your feature through Git|each feature has its own checkout|report.*json|coordinate with|write.*notes/i);}finally{rmSync(dir,{recursive:true,force:true});}
});

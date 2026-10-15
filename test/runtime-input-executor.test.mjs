import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {CHECK_INPUT_GUARD} from '../src/core/check-inputs';
import {checkRunFrom} from '../src/core/checks';
it('the real shell guard stops absent input before setup and reports verifier error',()=>{
 const inputs={version:3,required:['job-service'],values:{}};
 const result=spawnSync('sh',['-c',CHECK_INPUT_GUARD+'\nprintf should-not-run'],{encoding:'utf8',env:{...process.env,SUPERPOSE_CHECK_INPUTS:JSON.stringify(inputs)}});
 expect(result.status).toBe(94);expect(result.stdout).not.toContain('should-not-run');
 expect(checkRunFrom({exitCode:94,stdout:result.stdout,stderr:result.stderr,ms:1,step:1},{check:'check',timeoutSeconds:30,inputs},0,1).status).toBe('error');
});

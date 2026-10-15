import {test,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {options,deploymentConfig} from '../scripts/setup.mjs';
test('a selected account cannot silently disagree with the credential environment',()=>{
 expect(()=>options(['--account-id','b'.repeat(32),'--name','judge-demo'],{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)})).toThrow(/differs/);
 expect(options(['--name','judge-demo'],{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)}).account).toBe('a'.repeat(32));
});
test('a separate installation routes pushes only to its own namespace and workflows',()=>{
 const c=deploymentConfig(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'),'judge-demo','/tmp/clean-project');
 expect(c.name).toBe('judge-demo');expect(c.account_id).toBeUndefined();expect(c.artifacts[0].namespace).toBe('judge-demo');
 expect(c.triggers.events[0].filter.namespace).toBe('judge-demo');
 expect(c.triggers.events[0].targets[0].workflow_name).toBe(c.workflows.find(w=>w.binding==='PUSHES').name);
 expect(c.workflows.every(w=>w.name.startsWith('judge-demo-'))).toBe(true);expect(c.main).toBe('/tmp/clean-project/src/index.ts');
});

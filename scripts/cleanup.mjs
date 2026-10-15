#!/usr/bin/env bun
// Explicitly remove one locally recorded smoke/demo graph, retaining its receipt.
import{readFileSync,writeFileSync,existsSync}from'node:fs';import{join}from'node:path';
import{readConnection,ROOT}from'./setup.mjs';import{Api}from'../runner/lib.mjs';
const args=process.argv.slice(2).filter(x=>x!=='--');
if(args.includes('--help')||args.length!==1){console.log('bun run cleanup <graph-id>\nDeletes only a locally recorded smoke/demo graph and its Artifacts repositories. Keeps the deployment and local receipts.');if(!args.includes('--help'))process.exitCode=1;}
else{
 const id=args[0];if(!/^(smoke|demo)-[a-z0-9-]+$/.test(id))throw Error('Only smoke/demo graph IDs are accepted.');
 const path=join(ROOT,'.superpose/runs',id,'result.json');if(!existsSync(path))throw Error('No local receipt for this graph.');
 const receipt=JSON.parse(readFileSync(path)),c=readConnection();
 if(receipt.graph!==id||receipt.canvas!==c.url+'/g/'+id)throw Error('The receipt does not match the selected deployment.');
 const r=await new Api(c.url,id).request('DELETE','',{token:c.admin,timeoutMs:120000});
 if(!r.ok)throw Error('Cleanup failed: '+r.status+' '+(r.data?.message??r.data?.error??''));
 receipt.cleanedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(receipt,null,2));console.log('Deleted '+id+' and its Artifacts repositories. Deployment and local receipt retained.');
}

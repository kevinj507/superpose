#!/usr/bin/env bun
// Portable deployment; application credentials are generated, never printed.
import {existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import ts from 'typescript';

export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HELP=`Usage: bun run setup --account-id <Cloudflare account ID> --name <worker name>
Set CLOUDFLARE_API_TOKEN securely in the environment. Requires Workers Paid,
Artifacts and Containers access, Bun, and Git. Uses the pinned local Wrangler.
The name also identifies the Artifacts namespace and Workflow resources.
Generated credentials/configuration are private files under .superpose/.
Rerunning the same installation preserves its credentials.
--dry-run checks the deployment bundle without creating Cloudflare resources.
`;
export function options(args,env=process.env){
 const out={name:undefined,account:env.CLOUDFLARE_ACCOUNT_ID,dryRun:false};
 for(let i=0;i<args.length;i++){
  const a=args[i];if(a==='--')continue;
  if(a==='--help'||a==='-h')return {help:true};
  if(a==='--dry-run'){out.dryRun=true;continue;}
  if(a==='--name'||a==='--account-id'){const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing value for '+a);out[a==='--name'?'name':'account']=value;continue;}
  throw Error('Unknown option '+a);
 }
 if(!/^[a-z][a-z0-9-]{2,39}$/.test(out.name??''))throw Error('--name must contain 3–40 lowercase letters, digits or hyphens, starting with a letter.');
 if(!/^[a-f0-9]{32}$/i.test(out.account??''))throw Error('Provide --account-id or CLOUDFLARE_ACCOUNT_ID (32 hexadecimal characters).');
 if(env.CLOUDFLARE_ACCOUNT_ID&&env.CLOUDFLARE_ACCOUNT_ID!==out.account)throw Error('The explicit account differs from CLOUDFLARE_ACCOUNT_ID. Select one account consistently before setup.');
 return out;
}
export function deploymentConfig(source,name,root=ROOT){
 const parsed=ts.parseConfigFileTextToJson('wrangler.jsonc',source);if(parsed.error)throw Error('Invalid wrangler.jsonc');
 const config=parsed.config;delete config.account_id;
 config.name=name;config.main=resolve(root,config.main);config.assets.directory=resolve(root,config.assets.directory);config.workers_dev=true;
 const names=new Map(config.workflows.map(w=>[w.name,name+'-'+w.name.replace(/^superpose-/, '')]));
 config.workflows=config.workflows.map(w=>({...w,name:names.get(w.name)}));
 config.artifacts=config.artifacts.map(a=>({...a,namespace:name}));
 config.triggers.events=config.triggers.events.map(e=>({...e,filter:{...e.filter,namespace:name},targets:e.targets.map(t=>({...t,workflow_name:names.get(t.workflow_name)??t.workflow_name}))}));
 config.secrets={required:['ADMIN_TOKEN','AGENT_KEY']};return config;
}
function privateJson(file,data){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(data,null,2)+'\n',{mode:0o600});chmodSync(file,0o600);}
export function readConnection(file=join(ROOT,'.superpose/connection.json')){
 if(!existsSync(file))throw Error('Run bun run setup first, or pass --connection <private connection file>.');
 const c=JSON.parse(readFileSync(file,'utf8'));if(!c.url||!c.admin||!c.agent)throw Error('Incomplete connection file; setup has not finished.');return c;
}
export async function setup(args=process.argv.slice(2)){
 const opt=options(args);if(opt.help){console.log(HELP);return;}
 const token=process.env.CLOUDFLARE_API_TOKEN;if(!token&&!opt.dryRun)throw Error('CLOUDFLARE_API_TOKEN is missing. Supply a token scoped to your selected Cloudflare account.');
 const dir=join(ROOT,'.superpose/deployments',opt.name),statePath=join(dir,'connection.json');mkdirSync(dir,{recursive:true,mode:0o700});
 const existing=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):null;
 if(existing&&existing.account!==opt.account)throw Error('This deployment name is saved for another account. Choose another name or use the original account.');
 const connection=existing??{account:opt.account,name:opt.name,namespace:opt.name,admin:randomBytes(32).toString('hex'),agent:randomBytes(32).toString('hex')};
 const redact=text=>[token,connection.admin,connection.agent].filter(Boolean).reduce((s,key)=>s.replaceAll(key,'[redacted]'),String(text));
 async function cf(path,method='GET',body){
  const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+opt.account+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const data=await r.json();return {status:r.status,ok:r.ok&&data.success!==false,data};
 }
 function requireApi(r,what){if(!r.ok)throw Error(redact(what+' failed (HTTP '+r.status+'): '+JSON.stringify(r.data.errors??[])));return r.data.result;}
 async function wrangler(args){
  return new Promise((done,reject)=>{
   const child=spawn(process.execPath,['run',join(ROOT,'node_modules/wrangler/bin/wrangler.js'),...args],{cwd:ROOT,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:opt.account,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(dir,'wrangler.log')},stdio:['ignore','pipe','pipe']});
   let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',b=>{output+=b;process.stdout.write(redact(b));});
   child.on('error',reject);child.on('close',code=>code===0&&!/\[ERROR\]/.test(output)?done(output):reject(Error('Wrangler failed; see the output above.')));
  });
 }
 console.log(`Selected account ${opt.account}; Worker and Artifacts namespace ${opt.name}.`);
 if(!opt.dryRun){
  const remote=await cf('/workers/scripts/'+opt.name+'/settings');
  if(remote.ok&&!existing?.deploymentStarted)throw Error('A Worker with this name already exists, but this checkout has not deployed it. Choose a fresh name to avoid replacing another installation.');
  if(!remote.ok&&remote.status!==404)requireApi(remote,'Checking Worker access');
  const namespaces=requireApi(await cf('/artifacts/namespaces'),'Listing Artifacts namespaces');
  const list=Array.isArray(namespaces)?namespaces:(namespaces?.namespaces??[]);
  if(!list.some(n=>(n.namespace??n.name)===opt.name))requireApi(await cf('/artifacts/namespaces','POST',{namespace:opt.name}),'Creating Artifacts namespace');
  connection.deploymentStarted=true;
 }
 const config=deploymentConfig(readFileSync(join(ROOT,'wrangler.jsonc'),'utf8'),opt.name),configPath=join(dir,'wrangler.json');privateJson(configPath,config);
 privateJson(statePath,connection);privateJson(join(dir,'secrets.json'),{ADMIN_TOKEN:connection.admin,AGENT_KEY:connection.agent});
 const output=await wrangler(['deploy','--config',configPath,'--secrets-file',join(dir,'secrets.json'),...(opt.dryRun?['--dry-run']:[])]);
 if(opt.dryRun){console.log('Deployment bundle checked. No Cloudflare resources created.');return;}
 const urls=output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/g)??[];connection.url=urls.find(u=>new URL(u).hostname.startsWith(opt.name+'.'));
 if(!connection.url)throw Error('Deployment returned no workers.dev URL. Check that your account has a workers.dev subdomain, then rerun setup.');
 privateJson(statePath,connection);
 let healthy=false;
 for(let attempt=0;attempt<12;attempt++){
  try{const r=await fetch(connection.url+'/api/graphs/setup-check/snapshot',{headers:{Authorization:'Bearer '+connection.admin},signal:AbortSignal.timeout(10000)});const body=await r.json();if(r.ok&&Array.isArray(body.nodes)){healthy=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,2000));
 }
 if(!healthy)throw Error('Worker deployed but API health check did not pass. Rerun setup to retry with the same credentials.');
 privateJson(join(ROOT,'.superpose/connection.json'),connection);
 console.log(`Superpose is running: ${connection.url}\nPrivate connection saved to .superpose/connection.json.\nNext: bun run smoke`);
 return {url:connection.url,name:connection.name};
}
if(import.meta.main)setup().catch(err=>{console.error(err.message);process.exitCode=1;});

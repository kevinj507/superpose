#!/usr/bin/env bun
// Reuse setup's private connection without requiring the user to copy secrets.
import{spawn}from'node:child_process';import{join}from'node:path';
import{readConnection,ROOT}from'./setup.mjs';
const [kind,...args]=process.argv.slice(2).filter(x=>x!=='--');
if(!['plan','agents'].includes(kind))throw Error('Use bun run plan or bun run agents.');
const help=args.includes('--help')||args.includes('-h');
const c=help?null:readConnection();
const env={...process.env};
delete env.CLOUDFLARE_API_TOKEN;delete env.SUPERPOSE_ADMIN_TOKEN;delete env.SUPERPOSE_ENV;
if(c){env.SUPERPOSE_URL=c.url;env.SUPERPOSE_AGENT_KEY=c.agent;if(kind==='plan')env.SUPERPOSE_ADMIN_TOKEN=c.admin;}
// Bun would otherwise reload repository .env secrets after we remove them.
const child=spawn(process.execPath,['--no-env-file',join(ROOT,'runner',kind==='plan'?'plan.mjs':'run.mjs'),...args],{cwd:ROOT,env,stdio:'inherit'});
for(const signal of['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('close',code=>{process.exitCode=code??1;});

import { test, expect } from 'vitest';
import { groupGateway } from '../runner/experiment-gateway.mjs';
test('blocks other groups and arbitrary Git paths before making any upstream request', async()=>{
  const calls=[];
  const gateway=await groupGateway({graphId:'group-a',url:'https://sp.example',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({ok:true});}});
  try{
    const repo=gateway.register('https://git.example/group-a.git','scoped-write');
    expect((await fetch(gateway.url+'/api/graphs/group-b/snapshot')).status).toBe(403);
    expect((await fetch(repo+'/outside')).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await fetch(repo+'/info/refs?service=git-upload-pack')).status).toBe(200);
    expect(calls[0]).toMatchObject({url:'https://git.example/group-a.git/info/refs?service=git-upload-pack',options:{headers:{authorization:'Bearer scoped-write'}}});
  }finally{await gateway.close();}
});
test('rewrites granted remotes while preserving delegated API authentication',async()=>{
  const gateway=await groupGateway({graphId:'group-a',url:'https://sp.example',fetchImpl:async(url,options)=>{
    expect(options.headers.authorization).toBe('Bearer claim-lease');
    return Response.json({repo:{remote:'https://git.example/group-a.claim.c1.git'},git:{token:'git-lease'}});
  }});
  try{
    const result=await (await fetch(gateway.url+'/api/graphs/group-a/claims/c1/renew',{method:'POST',headers:{authorization:'Bearer claim-lease'}})).json();
    expect(result.repo.remote).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/git\//);
    expect(result.git.token).toBe('git-lease');
  }finally{await gateway.close();}
});
test('revocation rejects new and body-waiting pushes while preserving reads',async()=>{
  let releaseBody;
  const gateway=await groupGateway({graphId:'group-a',url:'https://sp.example',fetchImpl:async()=>Response.json({ok:true})});
  try{
    const repo=gateway.register('https://git.example/group-a.git','scoped-write');
    const pending=fetch(repo+'/git-receive-pack',{method:'POST',body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('start'));releaseBody=()=>{controller.enqueue(new TextEncoder().encode('pack'));controller.close();};}}),duplex:'half'});
    await new Promise(resolve=>setTimeout(resolve,100));
    gateway.register('https://git.example/group-a.git','renewed-write');
    expect(gateway.revoke('https://git.example/group-a.git')).toBe(true);
    gateway.authorize('https://git.example/group-a.git','successor-write');
    releaseBody();
    expect((await pending).status).toBe(403);
    expect((await fetch(repo+'/git-receive-pack',{method:'POST',body:'pack'})).status).toBe(200);
    expect((await fetch(repo+'/info/refs')).status).toBe(200);
  }finally{await gateway.close();}
});

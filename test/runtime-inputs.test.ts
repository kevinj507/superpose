import {describe,it,expect} from 'vitest';
import {Engine} from '../src/core/engine';
import {MemoryStore} from '../src/core/store';
import {validateCheckInputs} from '../src/core/check-inputs';
import type {CheckRun} from '../src/core/types';

function project(){
 const store=new MemoryStore(),engine=new Engine(store,{now:()=>1000},{leaseMs:60000,hedgeMs:60000});
 const article=engine.addAssumption('Affordable work finishes',{constitution:true,check:'node check.mjs',paths:['src/worker.mjs','src/retry.mjs']});
 const claims=['worker','retry','csv'].map(role=>engine.addClaim({statement:role,scope:['src/'+role+'.mjs']}));
 const leases=claims.map(c=>engine.claim(c.id,c.statement).token);
 return{store,engine,article,claims,leases};
}
const values=(revision:string)=>({'job-service':{revision,json:JSON.stringify({revision,temporaryCode:revision==='old'?'capacity_limit':'budget_limit'})}});
const run=(inputVersion:number,status:CheckRun['status']):CheckRun=>({inputVersion,status,command:'node check.mjs',startedAt:1,finishedAt:2,log:'Observed check result'});

describe('runtime inputs are part of the verification identity',()=>{
 it('automatically creates a verified finding for affected owners without agent-filed assumptions or findings',()=>{
  const {engine,article,claims}=project();engine.setCheckInputs('main',['job-service'],values('old'),0);
  expect(engine.recordInputCheck('main','code',1,[{article:article.id,check:run(1,'passed')}])).toBe(true);
  engine.setCheckInputs('main',['job-service'],values('new'),1);
  expect(engine.recordInputCheck('main','code',2,[{article:article.id,check:run(2,'failed')}])).toBe(true);
  const finding=engine.nodesForDisplay().find(n=>n.kind==='finding');expect(finding).toMatchObject({finder:'gate',status:'verified',where:claims.slice(0,2).map(c=>c.id),runtimeEvidence:{sha:'code',inputVersion:2}});
  expect(claims.map(c=>engine.getClaim(c.id).status)).toEqual(['stale','stale','claimed']);
  expect(engine.events().filter(e=>e.type==='claim.stale').flatMap(e=>e.claims)).not.toContain(claims[2]!.id);
 });
 it('rejects old versions, retains their history and leaves unavailable evidence unverified',()=>{
  const {engine,article,claims,leases}=project();engine.setCheckInputs('main',['job-service'],values('old'),0);engine.setCheckInputs('main',['job-service'],{},1);
  expect(engine.recordInputCheck('main','code',1,[{article:article.id,check:run(1,'passed')}])).toBe(false);
  expect(engine.recordInputCheck('main','code',2,[{article:article.id,check:run(2,'passed')}])).toBe(true);
  expect(engine.line('main').inputCheck?.status).toBe('error');expect(engine.nodesForDisplay().some(n=>n.kind==='finding')).toBe(false);
  expect(()=>engine.finish(claims[2]!.id,leases[2]!)).toThrow(/runtime changed|unavailable/);
  expect(engine.events().some(e=>e.data.current===false)).toBe(true);
 });
 it('does not let an old result overwrite a newer passing pair or certify a changed runtime',()=>{
  const {engine,article,claims,leases}=project();const c=claims[0]!;
  engine.setCheckInputs('main',['job-service'],values('old'),0);engine.push(c.id,leases[0]!,{sha:'head',changedPaths:['src/worker.mjs']});
  engine.setCheckInputs('main',['job-service'],values('new'),1);
  const pair={status:'passed' as const,startedAt:1,lineHead:null,articles:[article.id],inputVersion:2};
  engine.recordPair(c.id,'head',pair);engine.recordPair(c.id,'head',{...pair,inputVersion:1,status:'broken',broken:[article.id]});
  expect(engine.pushRecord(c.id,'head')?.pair).toMatchObject({status:'passed',inputVersion:2});expect(engine.getClaim(c.id).status).toBe('claimed');
  engine.setCheckInputs('main',['job-service'],values('later'),2);expect(()=>engine.finish(c.id,leases[0]!)).toThrow(/runtime changed/);
 });
 it('resolves a runtime finding only when the current checked line passes',()=>{
  const {engine,article}=project();engine.setCheckInputs('main',['job-service'],values('new'),0);
  engine.recordInputCheck('main','code',1,[{article:article.id,check:run(1,'failed')}]);
  expect(engine.recordInputCheck('main','old-code',1,[{article:article.id,check:run(1,'passed')}],false)).toBe(false);
  expect(engine.nodesForDisplay().find(n=>n.kind==='finding')?.status).toBe('verified');
  engine.recordInputCheck('main','fixed-code',1,[{article:article.id,check:run(1,'passed')}]);
  expect(engine.nodesForDisplay().find(n=>n.kind==='finding')?.status).toBe('resolved');
 });
 it('requires revisions and valid public JSON text',()=>{
  expect(()=>validateCheckInputs(['job-service'],{'job-service':{revision:'x',json:'not json'}})).toThrow();
  expect(()=>validateCheckInputs(['job-service'],{'job-service':{revision:'',json:'{}'}})).toThrow();
 });
 it('deduplicates repeated failed audits instead of staling a repair again',()=>{
  const {engine,article,claims,leases}=project();engine.setCheckInputs('main',['job-service'],values('new'),0);
  engine.recordInputCheck('main','code',1,[{article:article.id,check:run(1,'failed')}]);
  engine.replan(claims[0]!.id,leases[0]!,{restsOn:[]});
  engine.recordInputCheck('main','code',1,[{article:article.id,check:{...run(1,'failed'),log:'same failure with another duration'}}]);
  expect(engine.getClaim(claims[0]!.id).status).toBe('claimed');expect(engine.nodesForDisplay().filter(n=>n.kind==='finding')).toHaveLength(1);
 });
 it('does not apply a result for a replaced check command',()=>{
  const {engine,article}=project();engine.setCheckInputs('main',['job-service'],values('new'),0);
  expect(engine.recordInputCheck('main','code',1,[{article:article.id,check:{...run(1,'passed'),command:'old check'}}])).toBe(false);
  expect(engine.line('main').inputCheck).toBeUndefined();
 });
});

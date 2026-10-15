import{it,expect}from'vitest';import{describeNotice,executableArticles}from'../runner/lib.mjs';
it('runtime alerts identify checked code and relevant owners without inventing a merge or culprit',()=>{
 const event={type:'claim.stale',seq:1,data:{finding:'f1',constitution:true,assumptions:['a1'],where:['c1','c2'],statement:'Article failed under service-28',runtimeEvidence:{line:'main',sha:'abcdef1234',inputVersion:2}}};
 const n=describeNotice(event,{nodes:new Map([['a1',{statement:'affordable jobs finish'}]])},'c1');expect(n.title).toContain('STALE');expect(n.text).toContain('input version 2');expect(n.text).toContain('does not establish which claim');expect(n.text).not.toMatch(/Your commit alone passes|already landed/);
});
it('completion distinguishes prose promises from active executable articles on this line',()=>{
 const index={nodes:new Map([['c1',{line:'main'}],['a1',{id:'a1',kind:'assumption',constitution:true,status:'holding',line:'main'}]]),snap:{lines:[{name:'main'}]}};
 expect(executableArticles(null,'c1')).toBeNull();expect(executableArticles(index,'c1')).toEqual([]);
 index.nodes.set('a2',{id:'a2',kind:'assumption',constitution:true,status:'holding',line:'main',check:'run'});
 index.nodes.set('a3',{id:'a3',kind:'assumption',constitution:true,status:'holding',line:'other',check:'run'});
 expect(executableArticles(index,'c1').map(a=>a.id)).toEqual(['a2']);
 index.nodes.get('a2').supersededOn={main:'a4'};expect(executableArticles(index,'c1')).toEqual([]);
});
it('an existing shared failure is a waiting receipt, with no invented blame or replan instruction',()=>{
 const n=describeNotice({type:'claim.pair_checked',seq:2,data:{sha:'abcd',status:'blocked',baselineBroken:['a1']}},{nodes:new Map([['a1',{statement:'affordable jobs finish'}]])},'c3');
 expect(n.title).toContain('WAITING FOR THE LINE');expect(n.text).toContain('claim remains active');expect(n.text).not.toMatch(/STALE|re-plan|Each alone holds/);
});

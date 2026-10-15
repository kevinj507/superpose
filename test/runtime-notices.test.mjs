import{it,expect}from'vitest';import{describeNotice}from'../runner/lib.mjs';
it('runtime alerts identify checked code and relevant owners without inventing a merge or culprit',()=>{
 const event={type:'claim.stale',seq:1,data:{finding:'f1',constitution:true,assumptions:['a1'],where:['c1','c2'],statement:'Article failed under service-28',runtimeEvidence:{line:'main',sha:'abcdef1234',inputVersion:2}}};
 const n=describeNotice(event,{nodes:new Map([['a1',{statement:'affordable jobs finish'}]])},'c1');expect(n.title).toContain('STALE');expect(n.text).toContain('input version 2');expect(n.text).toContain('does not establish which claim');expect(n.text).not.toMatch(/Your commit alone passes|already landed/);
});
it('an existing shared failure is a waiting receipt, with no invented blame or replan instruction',()=>{
 const n=describeNotice({type:'claim.pair_checked',seq:2,data:{sha:'abcd',status:'blocked',baselineBroken:['a1']}},{nodes:new Map([['a1',{statement:'affordable jobs finish'}]])},'c3');
 expect(n.title).toContain('WAITING FOR THE LINE');expect(n.text).toContain('claim remains active');expect(n.text).not.toMatch(/STALE|re-plan|Each alone holds/);
});

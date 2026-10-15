// Connect an owner's public service snapshot to the product's normal check path.
// This publishes observations only. No finding, diagnosis, or oracle result is sent.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export class RuntimeInputAdapter {
 constructor({api,admin,line='main',name='job-service',file,onPublish=()=>{}}){Object.assign(this,{api,admin,line,name,file,onPublish});this.digest=null;this.version=0;}
 async publish(){
  const json=readFileSync(this.file,'utf8'),data=JSON.parse(json);if(typeof data.revision!=='string')throw Error('The service snapshot needs a revision');
  const digest=createHash('sha256').update(json).digest('hex');if(digest===this.digest)return this.version;
  const snapshot=await this.api.snapshot();if(!snapshot.ok)throw Error('Cannot read declared-input version');
  const line=snapshot.data.lines.find(l=>l.name===this.line);const baseVersion=line?.checkInputs?.version??0;
  const response=await this.api.request('POST','/lines/'+this.line+'/check-inputs',{token:this.admin,body:{baseVersion,required:[this.name],values:{[this.name]:{revision:data.revision,json}}}});
  if(!response.ok)throw Error('Cannot publish declared runtime inputs: '+response.status+' '+response.data?.message);
  this.digest=digest;this.version=response.data.version;this.onPublish({version:this.version,revision:data.revision,digest});return this.version;
 }
}

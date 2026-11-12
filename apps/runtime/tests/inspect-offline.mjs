/** Cross-language test utility: consume only a host-verified snapshot in shared local UI adapter. */
import assert from 'node:assert/strict';
import { verifyBundle } from '../src/offline/verify.ts';
import { TrustStore } from '../src/offline/trust.ts';
import { LocalResourceAdapter } from '../../web/src/features/resources/adapters.ts';
const [archive,profile,destination]=process.argv.slice(2);
const verified=await verifyBundle(archive,{trust:new TrustStore(profile),destination,debug:true});
const adapter=new LocalResourceAdapter(verified.resourceSnapshot());
const root=verified.snapshot.validationTarget;
if(root){
 const draft=await adapter.draft(root.resourceId);
 assert.equal(draft.revision,root.revision);
 assert.deepEqual(draft.content,((asset)=>({kind:asset.kind,document:asset.document}))(verified.snapshot.assets.find(a=>a.versionId===root.versionId)));
}else{
 for(const resource of (await adapter.list()).items){
  assert.equal((await adapter.draft(resource.id)).content.kind,resource.kind);
  for(const version of (await adapter.versions(resource.id)).items){
   const files=await adapter.sourceFiles(resource.id,version.id);
   for(const file of files.files)assert.equal(typeof await adapter.source(resource.id,version.id,file),'string');
  }
 }
}
assert.equal(adapter.readOnly,true);
process.stdout.write('Verified local resource adapter snapshot.\n');

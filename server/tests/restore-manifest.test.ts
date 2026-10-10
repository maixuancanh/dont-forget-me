import { expect, it } from 'vitest';
import { MemoryRecoveryService, sdkRecoveryStore, type ExactRecoveryStore, type RecoveryAnchor } from '../src/memory/recovery.js';
import { contentHash, serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2, MemoryReceipt } from '../src/domain/contracts.js';
import { operationNamespace } from '../src/memory/operations.js';
const scope = {userId:'u',runId:'r',revision:1,accountBindingId:'b',owner:'owner',network:'local' as const};
function fixture() {
  const bytes = new Map<string,string>(), directories: RecoveryAnchor[]=[];
  const store: ExactRecoveryStore = { directory:async()=>({anchors:directories,complete:true}),read:async(_s,a)=>{if(!bytes.has(a.blobId))throw new Error('EXPIRED');return bytes.get(a.blobId)!;},write:async(_s,namespace,b)=>{const a={blobId:`blob-${contentHash(b)}`,contentHash:contentHash(b)};bytes.set(a.blobId,b);if(namespace.endsWith(':directory'))directories.push(a);return a;}};
  const service = new MemoryRecoveryService(store);
  function record(id:string, sequence:number, sourceIds:string[]=[]){
    const r:MemoryRecordV2={schemaVersion:2,id,eventId:`e-${id}`,userId:'u',runId:'r',sessionId:'s',sequence,storyVersion:'v',beatId:'b',inGameDay:1,createdAt:'2026-10-10T00:00:00Z',actor:'player',kind:sourceIds.length?'interpretation':'utterance',text:`Unique ${id}`,epistemicStatus:'said',sourceIds,originIds:sourceIds.length?sourceIds:[id],recipients:['player'],entityIds:[],propositionIds:[]};
    const serialized=serializeMemoryRecord(r),blobId=`original-${id}`;bytes.set(blobId,serialized.bytes);
    const receipt:MemoryReceipt={recordId:id,contentHash:serialized.contentHash,blobId,accountBindingId:'b',network:'local',namespace:operationNamespace(scope),state:'retrievable'};
    return {bytes:serialized.bytes,receipt};
  }
  return {bytes,directories,store,service,record};
}
it('rebuilds >100 exact records in fresh service from multi-chunk remote directory',async()=>{
  const f=fixture(),records=Array.from({length:205},(_,i)=>f.record(`r${i}`,i));
  const published=await f.service.publish(scope,{storyVersion:'v',generation:0,records,tombstoneIds:[]});
  expect(published.directory.chunks).toHaveLength(3);
  const fresh=new MemoryRecoveryService(f.store),head=await fresh.discover(scope),restored=await fresh.rebuild(scope,head.anchor,'v');
  expect(restored.completeness).toBe('verified');expect(restored.records).toHaveLength(205);expect(restored.projection.orderedRecordIds[204]).toBe('r204');
});
it('keeps tombstones across directory history and blocks derived descendants',async()=>{
  const f=fixture(),records=[f.record('root',0),f.record('derived',1,['root']),f.record('nested',2,['derived'])];
  const first=await f.service.publish(scope,{storyVersion:'v',generation:0,records,tombstoneIds:[]});
  const second=await f.service.publish(scope,{storyVersion:'v',generation:1,previous:first.anchor,records,tombstoneIds:['root']});
  const result=await f.service.rebuild(scope,(await f.service.discover(scope)).anchor,'v');
  expect(result.records).toEqual([]);expect(result.blockedRecordIds.sort()).toEqual(['derived','nested']);expect(result.completeness).toBe('verified');
  await expect(f.service.publish(scope,{storyVersion:'v',generation:2,previous:second.anchor,records,tombstoneIds:[]})).rejects.toThrow('HISTORY_REGRESSION');
});
it('expired original yields partial read-only; missing chunk fails closed',async()=>{
  const f=fixture(),head=await f.service.publish(scope,{storyVersion:'v',generation:0,records:[f.record('one',0)],tombstoneIds:[]});
  f.bytes.delete('original-one');expect(await f.service.rebuild(scope,head.anchor,'v')).toMatchObject({completeness:'partial',projectionReadOnly:true,unavailableIds:['one']});
  f.bytes.delete(head.directory.chunks[0].blobId);await expect(f.service.rebuild(scope,head.anchor,'v')).rejects.toThrow('EXPIRED');
});
it('rejects incomplete directory enumeration, tampering, foreign scope and wrong story',async()=>{
  const f=fixture(),head=await f.service.publish(scope,{storyVersion:'v',generation:0,records:[f.record('one',0)],tombstoneIds:[]});
  await expect(f.service.rebuild(scope,head.anchor,'other')).rejects.toThrow('STORY_VERSION');
  await expect(f.service.rebuild({...scope,userId:'foreign'},head.anchor,'v')).rejects.toThrow('SCOPE');
  f.store.directory=async()=>({anchors:f.directories,complete:false});await expect(f.service.discover(scope)).rejects.toThrow('ENUMERATION_INCOMPLETE');
  f.bytes.set(head.anchor.blobId,f.bytes.get(head.anchor.blobId)!.replace('dfm-recovery-directory','fake-recovery-directory'));await expect(f.service.rebuild(scope,head.anchor,'v')).rejects.toThrow('HASH');
});
it('rejects competing heads at equal generation rather than selecting arbitrary top-1',async()=>{
  const f=fixture();await f.service.publish(scope,{storyVersion:'v',generation:0,records:[f.record('one',0)],tombstoneIds:[]});
  await f.service.publish(scope,{storyVersion:'v',generation:0,records:[f.record('two',1)],tombstoneIds:[]});
  await expect(f.service.discover(scope)).rejects.toThrow('FORK');
});
it('real SDK writer requires owner/namespace and exact decrypted read-back, never trusts upload alone',async()=>{
  const f=fixture();let calls=0;
  const sdk={rememberAndWait:async(b:string,namespace?:string)=>{calls++;f.bytes.set('uploaded',b);return {id:'job',blob_id:'uploaded',owner:'owner',namespace:namespace!};}};
  const store=sdkRecoveryStore(async()=>sdk,f.store),bytes='canonical manifest bytes';
  expect(await store.write(scope,operationNamespace(scope,'manifests'),bytes,'idempotency')).toEqual({blobId:'uploaded',contentHash:contentHash(bytes)});expect(calls).toBe(1);
  const changed=sdkRecoveryStore(async()=>sdk,{directory:f.store.directory,read:async()=> 'different'});
  await expect(changed.write(scope,operationNamespace(scope,'manifests'),bytes,'idempotency')).rejects.toThrow('NOT_VERIFIED');
});

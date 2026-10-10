import {randomUUID} from 'node:crypto';
import type {MemoryReader,MemoryRecordV2,MemoryReceipt,RetrievalRequest,RetrievalResult,VerifiedSource} from '../domain/contracts.js';
import {serializeMemoryRecord,verifySerializedRecord} from '../domain/serialization.js';
import {memoryReceiptSchema} from '../domain/schemas.js';

export interface ScopedRecord {record:MemoryRecordV2;receipt:MemoryReceipt}
export interface RetrievalScope {userId:string;runId:string;beatId:string;accountBindingId:string;namespace:string;network:'local'|'mainnet';records:ScopedRecord[];actorVisibleIds?:string[]}
export interface RemoteMemory {blobId:string;bytes:string}
export interface RetrievalBackend {
 semantic(query:string,namespace:string,limit:number):Promise<RemoteMemory[]>;
 /** Actual authorized decrypted read by reference. Never emulate with semantic top-K. */
 exact?: (blobId:string,namespace:string)=>Promise<RemoteMemory>;
 /** Managed-relayer reference hydration. May fail when index/search does not return the blob.
  * Never advertise this as direct storage access or namespace completeness. */
 reference?: (blobId:string,namespace:string,expectedText:string)=>Promise<RemoteMemory|undefined>;
}
export interface RetrievalTrace {traceId:string;namespace:string;queriedAt:string;admittedIds:string[];rejected:Array<{blobId:string;reason:string}>;missingExactRecordIds:string[];exactCapability:boolean}

/** Per-authenticated-user resolver authorizes before remote calls. It must resolve
 * current checkpoint, active binding and visibility from persisted server state.
 */
export class VerifiedMemoryReader implements MemoryReader {
 constructor(private resolve:(request:RetrievalRequest)=>Promise<RetrievalScope>,private remote:RetrievalBackend,private trace:(entry:RetrievalTrace)=>Promise<void>=async()=>{}){}
 async read(request:RetrievalRequest):Promise<RetrievalResult>{
  if(request.exactRecordIds.length>12||request.query.length>1500)throw new Error('RETRIEVAL_BUDGET_EXCEEDED');
  const scope=await this.resolve(request);
  if(scope.runId!==request.runId||scope.beatId!==request.currentBeatId)throw new Error('RETRIEVAL_SCOPE_MISMATCH');
  const visible=scope.records.filter(({record:r,receipt:p})=>r.userId===scope.userId&&r.runId===scope.runId&&
   (r.actor===request.actor||r.recipients.includes(request.actor)||scope.actorVisibleIds?.includes(r.id))&&p.recordId===r.id&&
   p.accountBindingId===scope.accountBindingId&&p.namespace===scope.namespace&&p.network===scope.network&&
   ['indexed','retrievable'].includes(p.state)&&Boolean(p.blobId));
  const byBlob=new Map(visible.map(r=>[r.receipt.blobId!,r]));
  const sources=new Map<string,VerifiedSource>();
  const entry:RetrievalTrace={traceId:randomUUID(),namespace:scope.namespace,queriedAt:new Date().toISOString(),admittedIds:[],rejected:[],missingExactRecordIds:[],exactCapability:Boolean(this.remote.exact)};
  const admit=(item:RemoteMemory,kind:VerifiedSource['retrieval'])=>{
   const expected=byBlob.get(item.blobId);
   if(!expected){entry.rejected.push({blobId:item.blobId,reason:'NOT_VISIBLE_IN_SCOPE'});return false;}
   try{
    const record=verifySerializedRecord(item.bytes,expected.receipt.contentHash);
    if(record.id!==expected.record.id||record.runId!==scope.runId||record.userId!==scope.userId)throw new Error('CONTENT_SCOPE_MISMATCH');
    // Match the complete immutable server representation, not only its logical ID.
    if(serializeMemoryRecord(expected.record).bytes!==item.bytes)throw new Error('CONTENT_MISMATCH');
    const previous=sources.get(record.id);
    if(!previous||kind==='exact')sources.set(record.id,{record,receipt:memoryReceiptSchema.parse({...expected.receipt,state:'retrievable',verifiedAt:entry.queriedAt,lastRecallAt:entry.queriedAt}),retrieval:kind});
    return true;
   }catch{entry.rejected.push({blobId:item.blobId,reason:'HASH_SCHEMA_OR_SCOPE_MISMATCH'});return false;}
  };
  // Exact references never depend on whether semantic search ranks them highly.
  await Promise.all([...new Set(request.exactRecordIds)].map(async id=>{
   const selected=visible.find(r=>r.record.id===id);
   if(!selected||(!this.remote.exact&&!this.remote.reference)){entry.missingExactRecordIds.push(id);return;}
   try{const item=this.remote.exact?await this.remote.exact(selected.receipt.blobId!,scope.namespace):await this.remote.reference!(selected.receipt.blobId!,scope.namespace,selected.record.text);if(!item||item.blobId!==selected.receipt.blobId||!admit(item,this.remote.exact?'exact':'verified_reference'))entry.missingExactRecordIds.push(id);}
   catch{entry.missingExactRecordIds.push(id);}
  }));
  const semantic=await this.remote.semantic(request.query,scope.namespace,6);
  for(const item of semantic.slice(0,6))admit(item,'semantic');
  // Recent IDs come from the acknowledged server ledger, not a global sort guess.
  if(this.remote.exact||this.remote.reference)await Promise.all([...visible].sort((a,b)=>b.record.sequence-a.record.sequence).slice(0,4).map(async selected=>{
   if(sources.has(selected.record.id))return;
   try{const item=this.remote.exact?await this.remote.exact(selected.receipt.blobId!,scope.namespace):await this.remote.reference!(selected.receipt.blobId!,scope.namespace,selected.record.text);if(item&&item.blobId===selected.receipt.blobId)admit(item,this.remote.exact?'recent':'verified_reference');}catch{/* absent data stays absent */}
  }));
  if([...sources.values()].reduce((size,s)=>size+s.record.text.length,0)>32000)throw new Error('RETRIEVAL_BUDGET_EXCEEDED');
  entry.admittedIds=[...sources.keys()];await this.trace(entry);
  return {traceId:entry.traceId,sources:[...sources.values()],missingExactRecordIds:entry.missingExactRecordIds,freshness:'live'};
 }
}

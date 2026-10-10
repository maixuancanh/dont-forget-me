import {contentHash} from '../domain/serialization.js';
import {operationNamespace,type OperationScope} from './operations.js';
import {recoveryDirectoryNamespace,type ExactRecoveryStore,type RecoveryAnchor} from './recovery.js';

interface ManagedSdk {
 recall(input:{query:string;namespace:string;limit:number}):Promise<{results:{blob_id:string;text:string}[]}>;
 rememberAndWait(bytes:string,namespace:string,options:{idempotencyKey:string;timeoutMs:number}):Promise<{owner:string;namespace:string;blob_id:string}>;
}
/** Chain enumeration establishes completeness; indexed recall only hydrates each known blob.
 * A missing indexed entry fails closed. This is not an index-independent Seal reader.
 */
export function managedRecoveryStore(sdkFor:(scope:OperationScope)=>Promise<ManagedSdk>,enumerate:(scope:OperationScope,namespace:string)=>Promise<{blobIds:string[];complete:boolean}>):ExactRecoveryStore {
 const namespaces=(scope:OperationScope)=>[recoveryDirectoryNamespace(scope),operationNamespace(scope,'manifests'),operationNamespace(scope)];
 async function lookup(scope:OperationScope,anchor:RecoveryAnchor,lanes=namespaces(scope),query=scope.runId){
  const sdk=await sdkFor(scope);
  for(const namespace of lanes){
   const response=await sdk.recall({query,namespace,limit:100});
   const match=response.results.find(r=>r.blob_id===anchor.blobId);
   if(!match)continue;
   if(Buffer.byteLength(match.text)>524288)throw Error('RECOVERY_PLAINTEXT_SIZE_INVALID');
   if(contentHash(match.text)!==anchor.contentHash)throw Error('RECOVERY_HASH_MISMATCH');
   return match.text;
  }
  throw Error('RECOVERY_REFERENCE_UNAVAILABLE');
 }
 return {
  provenance:'verified_reference_manifest_replay',
  async directory(scope,namespace){
   if(namespace!==recoveryDirectoryNamespace(scope))throw Error('RECOVERY_NAMESPACE_SCOPE_MISMATCH');
   const listed=await enumerate(scope,namespace);
   if(!listed.complete)throw Error('RECOVERY_DIRECTORY_ENUMERATION_INCOMPLETE');
   if(!listed.blobIds.length)return{anchors:[],complete:true};
   const response=await(await sdkFor(scope)).recall({query:'dfm-recovery-directory',namespace,limit:100});
   const anchors=listed.blobIds.map(blobId=>{
    const candidates=response.results.filter(r=>r.blob_id===blobId);
    if(candidates.length!==1)throw Error('RECOVERY_INDEX_INCOMPLETE');
    if(Buffer.byteLength(candidates[0].text)>524288)throw Error('RECOVERY_PLAINTEXT_SIZE_INVALID');
    return{blobId,contentHash:contentHash(candidates[0].text)};
   });
   return{anchors,complete:true};
  },
  read:lookup,
  async write(scope,namespace,bytes,idempotencyKey){
   if(!namespaces(scope).includes(namespace))throw Error('RECOVERY_NAMESPACE_SCOPE_MISMATCH');
   const result=await(await sdkFor(scope)).rememberAndWait(bytes,namespace,{idempotencyKey,timeoutMs:120000});
   if(result.owner!==scope.owner||result.namespace!==namespace||!result.blob_id)throw Error('RECOVERY_WRITE_SCOPE_MISMATCH');
   const anchor={blobId:result.blob_id,contentHash:contentHash(bytes)};
   // A large authority envelope is not a valid semantic search query.
   // Locate within the scoped namespace, then verify the exact blob and all bytes.
   await lookup(scope,anchor,[namespace],scope.runId);
   return anchor;
  },
 };
}

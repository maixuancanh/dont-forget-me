import {it,expect} from 'vitest';
import {managedRecoveryStore} from '../src/memory/managed-recovery.js';
import {contentHash} from '../src/domain/serialization.js';
const scope={userId:'u',runId:'r',accountBindingId:'binding',owner:'owner',network:'mainnet' as const,revision:0};
const bytes='{"runId":"r","userId":"u"}';
const anchor={blobId:'blob',contentHash:contentHash(bytes)};
function fixture(results=[{blob_id:'blob',text:bytes}],ids=['blob']){
 const calls:string[]=[];
 const sdk={recall:async(args:{namespace:string})=>{calls.push(args.namespace);return{results};},rememberAndWait:async()=>({owner:'owner',namespace:'dfm:v2:u:r:manifests',blob_id:'blob'})};
 return{calls,store:managedRecoveryStore(async()=>sdk,async()=>({blobIds:ids,complete:true}))};
}
it('enumerates chain entries and checks fresh decrypted reference bytes',async()=>{
 const {store}=fixture();expect(await store.directory(scope,'dfm:v2:u:directory')).toEqual({anchors:[anchor],complete:true});expect(await store.read(scope,anchor)).toBe(bytes);
});
it('cannot claim complete enumeration when the index omits a chain blob',async()=>{
 await expect(fixture([],['blob']).store.directory(scope,'dfm:v2:u:directory')).rejects.toThrow('RECOVERY_INDEX_INCOMPLETE');
});
it('rejects same-id bytes whose hash does not match the anchor',async()=>{
 await expect(fixture([{blob_id:'blob',text:'wrong'}]).store.read(scope,anchor)).rejects.toThrow('RECOVERY_HASH_MISMATCH');
});
it('verifies uploaded bytes by fresh recall before publishing an anchor',async()=>{
 expect(await fixture().store.write(scope,'dfm:v2:u:r:manifests',bytes,'idempotency')).toEqual(anchor);
 await expect(fixture([]).store.write(scope,'dfm:v2:u:r:manifests',bytes,'idempotency')).rejects.toThrow('RECOVERY_REFERENCE_UNAVAILABLE');
});
it('never queries namespaces outside the authenticated account scope',async()=>{
 const {store,calls}=fixture();await expect(store.directory(scope,'dfm:v2:other:directory')).rejects.toThrow('RECOVERY_NAMESPACE_SCOPE_MISMATCH');expect(calls).toEqual([]);
});
it('verifies large backups with a bounded locator query and full byte hash',async()=>{
 const large=JSON.stringify({runId:'r',payload:'x'.repeat(40000)});const queries:string[]=[];
 const sdk={recall:async(args:{query:string})=>{queries.push(args.query);if(args.query.length>512)throw Error('QUERY_TOO_LARGE');return{results:[{blob_id:'large',text:large}]};},rememberAndWait:async()=>({owner:'owner',namespace:'dfm:v2:u:r:manifests',blob_id:'large'})};
 const store=managedRecoveryStore(async()=>sdk,async()=>({blobIds:[],complete:true}));
 expect(await store.write(scope,'dfm:v2:u:r:manifests',large,'large-stable-key')).toEqual({blobId:'large',contentHash:contentHash(large)});
 expect(queries).toEqual(['r']);
});

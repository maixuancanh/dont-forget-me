import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Transaction} from '@mysten/sui/transactions';
import {normalizeSuiAddress} from '@mysten/sui/utils';
import type {PostgresRepository} from '../persistence/repository.js';
import {AuthorityError,transaction} from '../persistence/transactions.js';
import {verifySerializedRecord,canonicalSerialize,contentHash} from '../domain/serialization.js';
import type {MemoryReceipt} from '../domain/contracts.js';
import {deletionScope} from './deletion.js';
import {withoutTombstones} from './tombstones.js';
import {validateBudget} from './budget.js';
import type {WalrusChainProvider,PreparedLifecycleTransaction} from './walrus-chain.js';
export type WalletRenewProvider=Pick<WalrusChainProvider,'resolveOwnedBlob'|'inspect'|'quote'|'prepare'|'verifyPrepared'>;
export class WalletRenewService{
 constructor(private repo:PostgresRepository,private provider:WalletRenewProvider){}
 async migrate(){await this.repo.pool.query(await readFile(new URL('../../migrations/008_wallet_renewals.sql',import.meta.url),'utf8'));}
 private async selected(userId:string,runId:string,ids:string[]){
  const run=await this.repo.getRun(userId,runId);
  const records=await withoutTombstones(this.repo.pool,userId,runId,(await this.repo.pool.query('SELECT payload_bytes,content_hash FROM memory_records WHERE user_id=$1 AND run_id=$2',[userId,runId])).rows.map(r=>verifySerializedRecord(r.payload_bytes,r.content_hash)));
  if(!ids.length||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>!records.some(r=>r.id===id&&r.recipients.includes('player'))))throw new AuthorityError('RENEW_SOURCE_UNAVAILABLE',403);
  const binding=typeof run.state.memoryBindingId==='string'?run.state.memoryBindingId:`runtime:mainnet:${userId}`,namespace=`dfm:v2:${userId}:${runId}:case`;
  const receipts=(await this.repo.pool.query("SELECT r.receipt FROM memory_receipts r JOIN memory_records m ON m.id=r.record_id WHERE m.user_id=$1 AND m.run_id=$2 AND r.account_binding_id=$3 AND r.namespace=$4 AND r.state IN ('indexed','retrievable') AND r.content_hash=m.content_hash",[userId,runId,binding,namespace])).rows.map(r=>r.receipt as MemoryReceipt);
  const scope=deletionScope(records,receipts,ids);
  if(scope.blobs.length===0||scope.recordIds.some(id=>!receipts.some(r=>r.recordId===id&&r.network==='mainnet'&&r.blobId&&r.verifiedAt)))throw new AuthorityError('RENEW_RECEIPT_UNAVAILABLE');
  return{run,binding,namespace,scope};
 }
 async prepare(userId:string,runId:string,input:{address:string;recordIds:string[];epochs:number;ceiling:string}){
  if(!Number.isInteger(input.epochs)||input.epochs<1||input.epochs>53||!/^\d{1,30}$/.test(input.ceiling))throw new AuthorityError('RENEW_BUDGET_REQUIRED',400);
  const address=normalizeSuiAddress(input.address),selected=await this.selected(userId,runId,input.recordIds),objects=[];
  for(const blob of selected.scope.blobs){const actual=blob.objectId?await this.provider.inspect(blob):await this.provider.resolveOwnedBlob(blob.blobId,address);if(normalizeSuiAddress(actual.owner)!==address||actual.blobId!==blob.blobId||actual.network!=='mainnet'||actual.currentEpoch>=actual.endEpoch)throw new AuthorityError('RENEW_OBJECT_OWNER_MISMATCH',403);objects.push(actual);}
  const quote=await this.provider.quote(objects,input.epochs);validateBudget(quote,input.ceiling);if(quote.epochs!==input.epochs)throw new AuthorityError('RENEW_QUOTE_EPOCH_MISMATCH');
  const operationId=randomUUID(),prepared=await this.provider.prepare({operationId,kind:'renew',blobs:objects,quote,ceiling:input.ceiling},address);
  const preview={operationId,address,recordIds:selected.scope.recordIds,selectedRecordIds:input.recordIds,objects,quote,ceiling:input.ceiling,binding:selected.binding,namespace:selected.namespace,runRevision:selected.run.revision,expiresAt:quote.expiresAt,expectedDigest:prepared.transactionDigest};
  const confirmationHash=contentHash(canonicalSerialize(preview));
  await transaction(this.repo.pool,async c=>{const run=await this.repo.lockedRun(c,userId,runId);if(run.revision!==selected.run.revision)throw new AuthorityError('RENEW_PREVIEW_STALE');await c.query("INSERT INTO memory_wallet_renewals(id,user_id,run_id,address,preview,confirmation_hash,prepared,status) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared')",[operationId,userId,runId,address,preview,confirmationHash,prepared]);});
  return {...preview,confirmationHash,chain:'sui:mainnet',txBytes:prepared.transactionBase64,transactionJson:await Transaction.from(Buffer.from(prepared.transactionBase64,'base64')).toJSON(),disclosure:'Renew only the listed active-account blob objects, preserving their blob IDs. Storage price and ceiling are integer FROST (1 WAL = 1,000,000,000 FROST). Your wallet pays storage WAL plus SUI gas. Sponsored copies are unchanged.'};
 }
 private async row(userId:string,runId:string,id:string){await this.repo.getRun(userId,runId);const row=(await this.repo.pool.query('SELECT * FROM memory_wallet_renewals WHERE id=$1 AND user_id=$2 AND run_id=$3',[id,userId,runId])).rows[0];if(!row)throw new AuthorityError('RENEW_OPERATION_NOT_FOUND',404);return row;}
 async confirm(userId:string,runId:string,id:string,confirmationHash:string,digest:string){const row=await this.row(userId,runId,id);if(row.confirmation_hash!==confirmationHash||digest!==row.prepared.transactionDigest)throw new AuthorityError('RENEW_CONSENT_OR_DIGEST_MISMATCH');if(row.status==='confirmed')return this.status(userId,runId,id);await this.repo.pool.query("UPDATE memory_wallet_renewals SET status='verifying' WHERE id=$1 AND status IN ('prepared','unknown')",[id]);try{await this.verify(row,digest);}catch{await this.repo.pool.query("UPDATE memory_wallet_renewals SET status='unknown',result=$2 WHERE id=$1 AND status<>'confirmed'",[id,{digest,errorCode:'RENEW_CHAIN_PROOF_PENDING'}]);}return this.status(userId,runId,id);}
 private async verify(row:any,digest:string){const prepared=row.prepared as PreparedLifecycleTransaction,proof=await this.provider.verifyPrepared(prepared,digest);const expected=prepared.request.blobs;if(proof.transactionDigest!==digest||proof.network!=='mainnet'||proof.objects.length!==expected.length||new Set(proof.objects.map(o=>o.objectId)).size!==expected.length||expected.some(b=>!proof.objects.some(o=>o.objectId===b.objectId&&o.blobId===b.blobId&&o.endEpoch===b.endEpoch+prepared.request.quote!.epochs)))throw Error('RENEW_CHAIN_PROOF_MISMATCH');await transaction(this.repo.pool,async c=>{for(const obj of proof.objects)await c.query("UPDATE memory_receipts r SET receipt=receipt||$1::jsonb,updated_at=now() FROM memory_records m WHERE m.id=r.record_id AND m.user_id=$2 AND m.run_id=$3 AND r.account_binding_id=$4 AND r.namespace=$5 AND r.receipt->>'blobId'=$6",[{objectId:obj.objectId,expiryEpoch:obj.endEpoch,transactionDigest:digest},row.user_id,row.run_id,row.preview.binding,row.preview.namespace,obj.blobId]);await c.query("UPDATE memory_wallet_renewals SET status='confirmed',result=$2 WHERE id=$1",[row.id,{proof,scope:'exact_active_account_blob_objects'}]);});}
 async status(userId:string,runId:string,id:string){const row=await this.row(userId,runId,id);if(['verifying','unknown'].includes(row.status))try{await this.verify(row,row.prepared.transactionDigest);}catch{}const fresh=await this.row(userId,runId,id);return{operationId:id,status:fresh.status,result:fresh.result};}
}

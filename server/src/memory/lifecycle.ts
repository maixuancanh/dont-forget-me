import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PostgresRepository } from '../persistence/repository.js';
import { transaction, AuthorityError } from '../persistence/transactions.js';
import { canonicalSerialize, contentHash, verifySerializedRecord } from '../domain/serialization.js';
import type { MemoryReceipt } from '../domain/contracts.js';
import { deletionScope } from './deletion.js';
import { validateBudget, type LifecycleQuote } from './budget.js';
export type LifecycleBlob = ReturnType<typeof deletionScope>['blobs'][number];
export interface ChainBlob { objectId: string; blobId: string; owner: string; deletable: boolean; endEpoch: number; currentEpoch: number; network: string }
export interface LifecycleProvider {
  capabilities: { delete: boolean; renew: boolean };
  inspect(blob: LifecycleBlob): Promise<ChainBlob>;
  /** Compare the server signer/delegation authority with actual onchain blob object ownership. */
  authorized(owner: string, objectId: string, kind: 'delete'|'renew'): Promise<boolean>;
  quote(blobs: readonly ChainBlob[], epochs: number): Promise<LifecycleQuote>;
  /** Must build the actual provider transaction and enforce the maximum WAL amount before signing. */
  execute(request: {operationId:string; kind:'delete'|'renew'; blobs:ChainBlob[]; quote?:LifecycleQuote; ceiling?:string}): Promise<{transactionDigest:string}>;
  /** Must fetch successful chain effects and exact deleted object IDs / renewed end epochs for this digest. */
  verify(request:{kind:'delete'|'renew'; blobs:ChainBlob[]; quote?:LifecycleQuote}, digest:string): Promise<{transactionDigest:string; network:string; objects:Array<{objectId:string; blobId:string; deleted?:boolean; endEpoch?:number}>}>;
}
export interface LifecycleAction { kind:'delete'|'renew'; recordIds:string[]; epochs?:number; ceiling?:string }
interface Preview { operationId:string; userId:string; runId:string; revision:number; action:LifecycleAction; recordIds:string[]; blobs:LifecycleBlob[]; chain:ChainBlob[]; quote?:LifecycleQuote; supported:boolean; disclosure:string }
export class LifecycleService {
 constructor(private repo:PostgresRepository,private provider?:LifecycleProvider,private deadlineMs=35000) {if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>120000)throw Error('INVALID_LIFECYCLE_DEADLINE');}
 async migrate(){const sql=await readFile(new URL('../../migrations/004_memory_lifecycle.sql',import.meta.url),'utf8');await transaction(this.repo.pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8798008)');await c.query(sql);});}
 private async scope(userId:string,runId:string,action:LifecycleAction,db=this.repo.pool){
  const rows=await db.query('SELECT payload_bytes,content_hash FROM memory_records WHERE user_id=$1 AND run_id=$2 ORDER BY id',[userId,runId]);
  const records=rows.rows.map(r=>verifySerializedRecord(r.payload_bytes,r.content_hash));
  if(records.some(r=>r.userId!==userId||r.runId!==runId))throw new AuthorityError('LIFECYCLE_SCOPE_MISMATCH');
  const receipts=await db.query('SELECT r.receipt FROM memory_receipts r JOIN memory_records m ON m.id=r.record_id WHERE m.user_id=$1',[userId]);
  return deletionScope(records,receipts.rows.map(r=>r.receipt as MemoryReceipt),action.recordIds);
 }
 async preview(userId:string,runId:string,action:LifecycleAction){
  if(!['delete','renew'].includes(action.kind))throw new AuthorityError('INVALID_LIFECYCLE_ACTION',400);
  const run=await this.repo.getRun(userId,runId), scope=await this.scope(userId,runId,action);
  const supported=!!this.provider?.capabilities[action.kind]&&scope.blobs.length>0&&scope.blobs.every(b=>!!b.objectId&&b.network==='mainnet'&&(action.kind!=='delete'||!b.sharedOutsideScope));
  const chain:ChainBlob[]=[];
  if(supported){for(const blob of scope.blobs){const current=await this.provider!.inspect(blob);if(current.objectId!==blob.objectId||current.blobId!==blob.blobId||current.network!==blob.network||current.currentEpoch>=current.endEpoch||!current.owner||(action.kind==='delete'&&!current.deletable))throw new AuthorityError('BLOB_LIFECYCLE_UNAVAILABLE');chain.push(current);}}
  let quote:LifecycleQuote|undefined;
  if(action.kind==='renew'){if(!Number.isSafeInteger(action.epochs)||action.epochs!<1||!action.ceiling)throw new AuthorityError('RENEW_BUDGET_REQUIRED',400);if(supported){quote=await this.provider!.quote(chain,action.epochs!);validateBudget(quote,action.ceiling);if(quote.epochs!==action.epochs)throw new AuthorityError('QUOTE_EPOCH_MISMATCH');}}
  const preview:Preview={operationId:randomUUID(),userId,runId,revision:run.revision,action, ...scope,chain,...(quote?{quote}:{}),supported,disclosure:action.kind==='delete'?'Confirmation immediately blocks these records and descendants in this application. External deletion requires blob object owner authorization and chain proof. Copies, caches and historical storage cannot be erased by this operation.':'Renewal requires actual blob object owner authorization, a current quote and the disclosed WAL ceiling; the memory account does not prove blob ownership.'};
  const confirmationHash=contentHash(canonicalSerialize(preview));await this.repo.pool.query("INSERT INTO memory_lifecycle_operations(id,user_id,run_id,kind,preview,confirmation_hash,status) VALUES($1,$2,$3,$4,$5,$6,'preview')",[preview.operationId,userId,runId,action.kind,preview,confirmationHash]);return {...preview,confirmationHash};
 }
 async confirm(userId:string,runId:string,operationId:string,confirmation:{confirmed:true;confirmationHash:string}){
  await this.repo.getRun(userId,runId);
  return transaction(this.repo.pool,async c=>{await c.query('SELECT id FROM runs WHERE id=$1 AND user_id=$2 FOR UPDATE',[runId,userId]);const row=(await c.query('SELECT * FROM memory_lifecycle_operations WHERE id=$1 AND user_id=$2 AND run_id=$3 FOR UPDATE',[operationId,userId,runId])).rows[0];if(!row)throw new AuthorityError('LIFECYCLE_NOT_FOUND',404);if(confirmation.confirmed!==true||confirmation.confirmationHash!==row.confirmation_hash)throw new AuthorityError('LIFECYCLE_CONSENT_REQUIRED');if(row.status!=='preview')return {operationId,status:row.status};const p=row.preview as Preview;
   const revision=(await c.query('SELECT revision FROM runs WHERE id=$1',[runId])).rows[0].revision;
   const fresh=await this.scope(userId,runId,p.action,c as unknown as typeof this.repo.pool);
   if(revision!==p.revision||canonicalSerialize(fresh)!==canonicalSerialize({recordIds:p.recordIds,blobs:p.blobs}))throw new AuthorityError('LIFECYCLE_PREVIEW_STALE');
   if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[runId])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
   if(p.quote)validateBudget(p.quote,p.action.ceiling!);
   if(p.action.kind==='delete')for(const id of p.recordIds)await c.query('INSERT INTO memory_tombstones(user_id,run_id,record_id,operation_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[userId,runId,id,operationId]);
   if(p.action.kind==='delete'){
    await c.query("UPDATE outbox_jobs SET state='permanent_failure',error_code='MEMORY_BLOCKED',lease_token=NULL,lease_expires_at=NULL WHERE run_id=$1 AND record_id=ANY($2::text[]) AND state IN ('queued','accepted','uploaded','retryable_failure')",[runId,p.recordIds]);
    if((await c.query("SELECT to_regclass('case_shares') present")).rows[0].present)await c.query("UPDATE case_shares s SET revoked_at=now() WHERE s.run_id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.snapshot->'sources') source JOIN memory_records m ON m.content_hash=source->>'sourceCanonicalHash' WHERE m.run_id=$1 AND m.id=ANY($3::text[]))",[runId,userId,p.recordIds]);
    await c.query("UPDATE runs SET state=(state-'epilogue'-'caseReview') || '{\"caseReviewInvalidated\":true,\"outcome\":\"pending\"}'::jsonb WHERE id=$1",[runId]);
   }
   const status=p.supported?'requested':'unsupported';await c.query('UPDATE memory_lifecycle_operations SET status=$2 WHERE id=$1',[operationId,status]);
   const updated=await c.query('UPDATE runs SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision',[runId]);return {operationId,status,runRevision:updated.rows[0].revision};});
 }
 async read(userId:string,runId:string,operationId:string){await this.repo.getRun(userId,runId);const row=(await this.repo.pool.query('SELECT id,status,dispatch_count,result,preview FROM memory_lifecycle_operations WHERE id=$1 AND user_id=$2 AND run_id=$3',[operationId,userId,runId])).rows[0];if(!row)throw new AuthorityError('LIFECYCLE_NOT_FOUND',404);return row;}
 async dispatch(userId:string,runId:string,operationId:string){
  await this.repo.getRun(userId,runId);
  const claimed=await this.repo.pool.query("UPDATE memory_lifecycle_operations SET status='executing',dispatch_count=1 WHERE id=$1 AND user_id=$2 AND run_id=$3 AND status='requested' AND dispatch_count=0 RETURNING preview",[operationId,userId,runId]);if(!claimed.rowCount)return this.read(userId,runId,operationId);
  const p=claimed.rows[0].preview as Preview;let status='unknown',result:unknown;
  let timer:ReturnType<typeof setTimeout>|undefined;let timedOut=false;
  try{await Promise.race([(async()=>{if(!this.provider?.capabilities[p.action.kind])throw Error('PROVIDER_UNAVAILABLE');if(p.quote)validateBudget(p.quote,p.action.ceiling!);
   const fresh:ChainBlob[]=[];for(const blob of p.blobs){const b=await this.provider.inspect(blob);const original=p.chain.find(x=>x.objectId===b.objectId);if(!original||canonicalSerialize(b)!==canonicalSerialize(original))throw Error('BLOB_CHAIN_STATE_CHANGED');fresh.push(b);}
   for(const blob of fresh)if(!await this.provider.authorized(blob.owner,blob.objectId,p.action.kind))throw Error('BLOB_OWNER_AUTHORIZATION_REQUIRED');
   if(timedOut)throw Error('LIFECYCLE_TIMEOUT');if(p.quote)validateBudget(p.quote,p.action.ceiling!);
   const request={operationId,kind:p.action.kind,blobs:fresh,...(p.quote?{quote:p.quote,ceiling:p.action.ceiling}:{})};const tx=await this.provider.execute(request);if(!tx.transactionDigest)throw Error('PROVIDER_DIGEST_REQUIRED');const proof=await this.provider.verify(request,tx.transactionDigest);
   if(proof.transactionDigest!==tx.transactionDigest||proof.network!=='mainnet'||proof.objects.length!==fresh.length||new Set(proof.objects.map(o=>o.objectId)).size!==fresh.length||fresh.some(b=>!proof.objects.some(o=>o.objectId===b.objectId&&o.blobId===b.blobId&&(p.action.kind==='delete'?o.deleted===true:Number.isSafeInteger(o.endEpoch)&&o.endEpoch!>=b.endEpoch+p.action.epochs!))))throw Error('LIFECYCLE_CHAIN_PROOF_MISMATCH');
   if(timedOut)throw Error('LIFECYCLE_TIMEOUT');status='confirmed';result={proof,scope:'exact_blob_objects',globalErasureProven:false};
  })(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Error('LIFECYCLE_TIMEOUT'));},this.deadlineMs);})]);
  }catch(error){result={errorCode:error instanceof Error?error.message:'LIFECYCLE_UNKNOWN'};}
  finally{if(timer)clearTimeout(timer);}
  await this.repo.pool.query("UPDATE memory_lifecycle_operations SET status=$2,result=$3 WHERE id=$1 AND status='executing'",[operationId,status,result]);return this.read(userId,runId,operationId);
 }
 /** Crash after claiming may have submitted a transaction. Never auto-dispatch again. */
 async recoverExecuting(){await this.repo.pool.query("UPDATE memory_lifecycle_operations SET status='unknown' WHERE status='executing'");}
}

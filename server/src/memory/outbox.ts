import {randomUUID} from 'node:crypto';
import {ZodError} from 'zod';
import type pg from 'pg';
import type {MemoryReceipt,WriteState} from '../domain/contracts.js';
import {verifySerializedRecord} from '../domain/serialization.js';
import {memoryReceiptSchema} from '../domain/schemas.js';
import type {AccountScope,MemwalRecordAdapter} from './memwal-adapter.js';
import {transaction} from '../persistence/transactions.js';
export interface OutboxJob {id:string;user_id:string;run_id:string;record_id:string;event_id:string;account_binding_id:string;namespace:string;representation_key:string;payload_bytes:string;content_hash:string;state:WriteState;accepted_job_id:string|null;receipt:MemoryReceipt|null;attempts:number;lease_token:string;}
export interface ResolvedOutboxScope extends AccountScope {accountId:string}
export type ScopeResolver=(binding:{id:string;userId:string;network:'local'|'mainnet';accountId:string;mode:string},job:Readonly<OutboxJob>)=>Promise<ResolvedOutboxScope>;
export class LeaseLostError extends Error {constructor(){super('OUTBOX_LEASE_LOST');}}
const permanentCodes=new Set(['CONTENT_HASH_MISMATCH','NON_CANONICAL_PAYLOAD','RECORD_SCOPE_MISMATCH','BINDING_SCOPE_MISMATCH','RECEIPT_CONTENT_MISMATCH','JOB_SCOPE_MISMATCH','RECALLED_SCOPE_MISMATCH','INVALID_INDEX_RECEIPT','INVALID_RECALL_RECEIPT','MEMORY_BLOCKED','VALIDATION_ERROR','SCHEMA_VALIDATION_ERROR','UNAUTHORIZED','FORBIDDEN']);
const transientCodes=new Set(['TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EXACT_CONTENT_NOT_RECALLED','RATE_LIMITED']);
/** Only allowlisted codes/status are persisted. Never serialize provider error bodies. */
export function classifyOutboxError(error:unknown):{code:string;permanent:boolean}{
 if(error instanceof ZodError||error instanceof SyntaxError)return {code:'SCHEMA_VALIDATION_ERROR',permanent:true};
 const field=(name:string):unknown=>error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,name)?.value:undefined;
 const code=field('code'),message=error instanceof Error?field('message'):undefined;
 const status=field('status')??field('statusCode');
 if(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599)return {code:`PROVIDER_HTTP_${status}`,permanent:status===400||status===401||status===403};
 const known=[code,message].find(v=>typeof v==='string'&&(permanentCodes.has(v)||transientCodes.has(v))) as string|undefined;
 if(known)return {code:known,permanent:permanentCodes.has(known)};
 return {code:'OUTBOX_PROVIDER_ERROR',permanent:false};
}
export interface OutboxOptions {leaseMs?:number;maxAttempts?:number;baseRetryMs?:number;maxRetryMs?:number;random?:()=>number;jitterRatio?:number}
/** Positive bounded jitter (default 0-20 percent); total wait never exceeds 30s cap. */
export function outboxRetryDelay(attempt:number,options:OutboxOptions={}):number{
 const cap=Math.max(0,options.maxRetryMs??30000),base=Math.max(0,options.baseRetryMs??1000);
 const random=options.random??Math.random;const sample=random();
 const unit=Number.isFinite(sample)?Math.min(1,Math.max(0,sample)):0;
 const jitter=Math.min(1,Math.max(0,options.jitterRatio??0.2));
 return Math.min(cap,base*2**Math.min(Math.max(attempt-1,0),20)*(1+unit*jitter));
}
export class PostgresMemoryOutbox {
 constructor(private pool:pg.Pool,private resolveScope:ScopeResolver,private adapterFor:(scope:ResolvedOutboxScope)=>Promise<Pick<MemwalRecordAdapter,'write'|'verifyRecall'>>,private options:OutboxOptions={}){}
 async claim():Promise<OutboxJob|undefined>{const r=await this.pool.query(`WITH candidate AS (SELECT id FROM outbox_jobs WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones d WHERE d.record_id=outbox_jobs.record_id AND d.run_id=outbox_jobs.run_id) AND state IN ('queued','accepted','uploaded','indexed','retryable_failure') AND retry_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY retry_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE outbox_jobs j SET lease_token=$1,lease_expires_at=clock_timestamp()+($2::double precision*interval '1 millisecond'),attempts=attempts+1,updated_at=clock_timestamp() FROM candidate c WHERE j.id=c.id RETURNING j.*`,[randomUUID(),this.options.leaseMs??120000]);return r.rows[0];}
 async renew(job:OutboxJob){const r=await this.pool.query(`UPDATE outbox_jobs SET lease_expires_at=clock_timestamp()+($3::double precision*interval '1 millisecond') WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id`,[job.id,job.lease_token,this.options.leaseMs??120000]);if(!r.rowCount)throw new LeaseLostError();}
 private async persist(job:OutboxJob,receipt:MemoryReceipt,network:AccountScope['network'],release=false){
  memoryReceiptSchema.parse(receipt);
  if(receipt.network!==network||receipt.recordId!==job.record_id||receipt.contentHash!==job.content_hash||receipt.accountBindingId!==job.account_binding_id||receipt.namespace!==job.namespace)throw new Error('RECEIPT_CONTENT_MISMATCH');
  await transaction(this.pool,async c=>{const r=await c.query(`UPDATE outbox_jobs SET state=$3,receipt=$4,accepted_job_id=COALESCE($5,accepted_job_id),error_code=NULL,updated_at=clock_timestamp(),lease_token=CASE WHEN $6 THEN NULL ELSE lease_token END,lease_expires_at=CASE WHEN $6 THEN NULL ELSE lease_expires_at END WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id`,[job.id,job.lease_token,receipt.state,receipt,receipt.jobId??null,release]);if(!r.rowCount)throw new LeaseLostError();await c.query(`INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(record_id,account_binding_id,namespace) DO UPDATE SET state=EXCLUDED.state,content_hash=EXCLUDED.content_hash,receipt=EXCLUDED.receipt,updated_at=clock_timestamp()`,[job.record_id,job.account_binding_id,job.namespace,receipt.state,job.content_hash,receipt]);});
 }
 private async fail(job:OutboxJob,error:unknown){if(error instanceof LeaseLostError)return;const {code,permanent:classifiedPermanent}=classifyOutboxError(error);const permanent=classifiedPermanent||job.attempts>=(this.options.maxAttempts??8);const delay=outboxRetryDelay(job.attempts,this.options);await this.pool.query(`UPDATE outbox_jobs SET state=$3,error_code=$4,retry_at=clock_timestamp()+($5::double precision*interval '1 millisecond'),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp()`,[job.id,job.lease_token,permanent?'permanent_failure':'retryable_failure',code,delay]);}
 async process(job:OutboxJob){try{
  if((await this.pool.query('SELECT record_id FROM memory_tombstones WHERE run_id=$1 AND record_id=$2',[job.run_id,job.record_id])).rowCount)throw new Error('MEMORY_BLOCKED');
  const record=verifySerializedRecord(job.payload_bytes,job.content_hash);
  if(record.id!==job.record_id||record.userId!==job.user_id||record.runId!==job.run_id||record.eventId!==job.event_id||job.representation_key!==`v2:${record.id}:${job.content_hash}`)throw new Error('RECORD_SCOPE_MISMATCH');
  const r=await this.pool.query(`SELECT b.* FROM account_bindings b JOIN memory_records m ON m.id=$3 AND m.run_id=$4 AND m.user_id=$2 WHERE b.id=$1 AND b.user_id=$2 AND b.status='active' AND m.payload_bytes=$5 AND m.content_hash=$6`,[job.account_binding_id,job.user_id,job.record_id,job.run_id,job.payload_bytes,job.content_hash]);const b=r.rows[0];if(!b)throw new Error('BINDING_SCOPE_MISMATCH');
  const scope=await this.resolveScope({id:b.id,userId:b.user_id,network:b.network,accountId:b.account_id,mode:b.mode},job);
  if(scope.accountBindingId!==b.id||scope.network!==b.network||scope.accountId!==b.account_id||scope.namespace!==job.namespace)throw new Error('BINDING_SCOPE_MISMATCH');
  const expectedNetwork:AccountScope['network']=b.network;
  const previous=job.receipt??undefined;
  if(job.accepted_job_id&&previous?.jobId!==job.accepted_job_id)throw new Error('RECEIPT_CONTENT_MISMATCH');
  if(previous&&(previous.network!==scope.network||previous.accountBindingId!==scope.accountBindingId||previous.namespace!==scope.namespace||previous.recordId!==record.id||previous.contentHash!==job.content_hash))throw new Error('RECEIPT_CONTENT_MISMATCH');
  await this.renew(job);const adapter=await this.adapterFor(scope);const indexed=await adapter.write(record,{accountBindingId:scope.accountBindingId,namespace:scope.namespace,network:expectedNetwork},previous,receipt=>this.persist(job,receipt,expectedNetwork));if(!['indexed','retrievable'].includes(indexed.state))throw new Error('INVALID_INDEX_RECEIPT');await this.persist(job,indexed,expectedNetwork);const verified=await adapter.verifyRecall(record,indexed,record.text);if(verified.state!=='retrievable')throw new Error('INVALID_RECALL_RECEIPT');await this.persist(job,verified,expectedNetwork,true);
 }catch(error){await this.fail(job,error);}}
 async runOnce(){const job=await this.claim();if(!job)return false;await this.process(job);return true;}
}


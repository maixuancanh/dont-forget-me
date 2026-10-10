import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AuthorityError} from '../persistence/transactions.js';
import type {PostgresRepository} from '../persistence/repository.js';
import type {OperationScope} from './operations.js';
import type {RecoveryPrincipal} from './authority-recovery.js';
import {canonicalSerialize} from '../domain/serialization.js';

type Publisher=(scope:OperationScope,principal:RecoveryPrincipal,jobId:string,capturedAt:Date)=>Promise<unknown>;
interface BackupView {operationId:string;status:'pending'|'running'|'retry'|'complete';revision:number;result?:unknown;error?:string}
/** Consent and job identity survive disconnect/restart. Remote work holds no SQL connection. */
export class AuthorityBackupService {
 private active=new Map<string,Promise<void>>();
 constructor(private repo:PostgresRepository,private publish:Publisher){}
 async migrate(){await this.repo.pool.query(await readFile(new URL('../../migrations/007_authority_backups.sql',import.meta.url),'utf8'));}
 async request(scope:OperationScope,principal:RecoveryPrincipal){
  if(scope.userId!==principal.userId)throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
  const run=await this.repo.getRun(principal.userId,scope.runId);if(run.revision!==scope.revision)throw new AuthorityError('REVISION_CONFLICT');
  const row=(await this.repo.pool.query(`INSERT INTO authority_backup_jobs(id,user_id,run_id,revision,binding_id,principal_hash,scope) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,run_id,revision,binding_id) DO UPDATE SET updated_at=authority_backup_jobs.updated_at RETURNING *`,[randomUUID(),scope.userId,scope.runId,scope.revision,scope.accountBindingId,principal.identityHash,scope])).rows[0];
  if(row.principal_hash!==principal.identityHash||canonicalSerialize(row.scope)!==canonicalSerialize(scope))throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
  this.kick(row,principal);return this.view(row);
 }
 async status(userId:string,runId:string,id:string,principal:RecoveryPrincipal){
  if(principal.userId!==userId)throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
  const row=(await this.repo.pool.query('SELECT * FROM authority_backup_jobs WHERE id=$1 AND user_id=$2 AND run_id=$3',[id,userId,runId])).rows[0];
  if(!row||row.principal_hash!==principal.identityHash)throw new AuthorityError('FORBIDDEN',403);
  this.kick(row,principal);return this.view(row);
 }
 private view(row:any):BackupView{return {operationId:row.id,status:row.status,revision:row.revision,...(row.status==='complete'?{result:row.result}:{error:row.error_code??undefined})};}
 private kick(row:any,principal:RecoveryPrincipal){
  if(row.status==='complete'||this.active.has(row.id))return;
  const work=this.dispatch(row,principal).catch(()=>{}).finally(()=>this.active.delete(row.id));this.active.set(row.id,work);
 }
 private async dispatch(row:any,principal:RecoveryPrincipal){
  const lease=randomUUID();
  const claimed=await this.repo.pool.query(`UPDATE authority_backup_jobs SET status='running',lease_token=$2,lease_until=now()+interval '60 seconds',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1 AND status<>'complete' AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,[row.id,lease]);
  if(!claimed.rowCount)return;
  const heartbeat=setInterval(()=>{void this.repo.pool.query("UPDATE authority_backup_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2",[row.id,lease]).catch(()=>{});},15000);heartbeat.unref();
  try{
   const result=await this.publish(claimed.rows[0].scope,principal,row.id,new Date(row.created_at));
   await this.repo.pool.query("UPDATE authority_backup_jobs SET status='complete',result=$3,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[row.id,lease,result]);
  }catch(e){
   const message=e instanceof Error?e.message:'';
   const code=/^[A-Z_]+$/.test(message)?message:'BACKUP_STORAGE_PENDING';
   const candidate=(e as {jobId?:unknown})?.jobId;
   const jobId=typeof candidate==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(candidate)?candidate:null;
   await this.repo.pool.query("UPDATE authority_backup_jobs SET status='retry',error_code=$3,upstream_job_id=COALESCE($4,upstream_job_id),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[row.id,lease,code,jobId]);
  }finally{clearInterval(heartbeat);}
 }
 async drain(){await Promise.allSettled([...this.active.values()]);}
}

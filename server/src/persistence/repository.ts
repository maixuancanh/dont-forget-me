import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonicalSerialize,contentHash,serializeMemoryRecord} from '../domain/serialization.js';
import type {MemoryRecordV2} from '../domain/contracts.js';
import {migrateV1ToV2} from '../migrations/v1-to-v2.js';
import type {State} from '../model.js';
import {AuthorityError,transaction} from './transactions.js';
export interface Checkpoint {beatId:string; day:number; sceneId:string; stepIndex:number; scheduleIndex:number; phase:'dialogue'|'order'|'payment'|'complete';}
export interface AuthoritativeRun {id:string; userId:string; storyVersion:string; revision:number; eventSequence:number; checkpoint:Checkpoint; state:Record<string,unknown>; status:string;}
export interface MutationInput {userId:string; runId:string; expectedRevision:number; eventId:string; clientActionId:string; kind:string; payload:unknown;}
export interface CommitTurnInput {userId:string;runId:string;expectedRevision:number;clientTurnId:string;eventId:string;response:unknown;records:MemoryRecordV2[];bindingId?:string;namespace?:string;request?:unknown;turnId?:string;}
const asRun=(r:any):AuthoritativeRun=>({id:r.id,userId:r.user_id,storyVersion:r.story_version,revision:r.revision,eventSequence:r.event_sequence,checkpoint:r.checkpoint,state:r.state,status:r.status});
export class PostgresRepository {
  constructor(public readonly pool:pg.Pool) {}
  async migrate() {const sql=await readFile(new URL('../../migrations/001_memory_v2.sql',import.meta.url),'utf8'); await transaction(this.pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(8798005)');await c.query(sql);await c.query(await readFile(new URL('../../migrations/004_memory_lifecycle.sql',import.meta.url),'utf8'));});}
  async upsertUser(issuer:string,subject:string,displayName=''):Promise<string> {
    const r=await this.pool.query('INSERT INTO users(id,issuer,subject,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id',[randomUUID(),issuer,subject,displayName]); return r.rows[0].id;
  }
  async createRun(input:{userId:string;storyVersion:string;initialCheckpoint:Checkpoint;id?:string}) {
    const r=await this.pool.query('INSERT INTO runs(id,user_id,story_version,checkpoint) VALUES($1,$2,$3,$4) RETURNING *',[input.id??randomUUID(),input.userId,input.storyVersion,input.initialCheckpoint]);return asRun(r.rows[0]);
  }
  async getRun(userId:string,runId:string):Promise<AuthoritativeRun> {
    const r=await this.pool.query('SELECT * FROM runs WHERE id=$1 AND user_id=$2',[runId,userId]); if(!r.rowCount) throw new AuthorityError('FORBIDDEN',403);return asRun(r.rows[0]);
  }
  async lockedRun(c:pg.PoolClient,userId:string,runId:string) {const r=await c.query('SELECT * FROM runs WHERE id=$1 AND user_id=$2 FOR UPDATE',[runId,userId]);if(!r.rowCount)throw new AuthorityError('FORBIDDEN',403);return asRun(r.rows[0]);}
  async mutateRun<T>(input:MutationInput,apply:(c:pg.PoolClient,run:AuthoritativeRun,eventSequence:number)=>Promise<T>,persist?:(c:pg.PoolClient,run:AuthoritativeRun,sequence:number,result:T)=>Promise<void>):Promise<{result:T;run:AuthoritativeRun;replayed:boolean}> {
    const hash=contentHash(canonicalSerialize({kind:input.kind,payload:input.payload}));
    return transaction(this.pool,async c=>{
      const run=await this.lockedRun(c,input.userId,input.runId);
      const prior=await c.query('SELECT event_id,request_hash,payload FROM domain_events WHERE run_id=$1 AND (event_id=$2 OR client_action_id=$3)',[input.runId,input.eventId,input.clientActionId]);
      if(prior.rowCount) {if(prior.rows[0].request_hash!==hash)throw new AuthorityError('IDEMPOTENCY_CONFLICT');return {result:prior.rows[0].payload.result as T,run,replayed:true};}
      if(run.revision!==input.expectedRevision)throw new AuthorityError('REVISION_CONFLICT');
      const sequence=run.eventSequence+1; const result=await apply(c,run,sequence);
      await c.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,client_action_id,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[run.id,input.eventId,input.userId,sequence,input.kind,input.clientActionId,{request:input.payload,result},hash]);
      await persist?.(c,run,sequence,result);
      const updated=await c.query('UPDATE runs SET revision=revision+1,event_sequence=$3,checkpoint=$4,state=$5,status=$6,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING *',[run.id,input.expectedRevision,sequence,run.checkpoint,run.state,run.status]);
      if(!updated.rowCount)throw new AuthorityError('REVISION_CONFLICT'); return {result,run:asRun(updated.rows[0]),replayed:false};
    });
  }
  async getTurn(userId:string,runId:string,clientTurnId:string) {
    const r=await this.pool.query('SELECT t.* FROM turns t JOIN runs r ON r.id=t.run_id WHERE t.run_id=$1 AND r.user_id=$2 AND t.client_turn_id=$3',[runId,userId,clientTurnId]);return r.rows[0];
  }
  async commitTurn(input:CommitTurnInput) {
    // Generation and retrieval already completed; immutable serialization occurs outside SQL transaction.
    const records=input.records.map(record=>({record,...serializeMemoryRecord(record)}));
    const hash=contentHash(canonicalSerialize(input.request??{response:input.response,records:input.records}));
    return transaction(this.pool,async c=>{
      const run=await this.lockedRun(c,input.userId,input.runId);
      const existing=await c.query('SELECT * FROM turns WHERE run_id=$1 AND client_turn_id=$2',[run.id,input.clientTurnId]);
      if(existing.rowCount) {if(existing.rows[0].request_hash!==hash)throw new AuthorityError('IDEMPOTENCY_CONFLICT');return {turnId:existing.rows[0].id,response:existing.rows[0].response,runRevision:existing.rows[0].committed_revision,replayed:true};}
      const outstanding=await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id]);
      if(outstanding.rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
      if(run.revision!==input.expectedRevision)throw new AuthorityError('REVISION_CONFLICT');
      const sequence=run.eventSequence+1,turnId=input.turnId??randomUUID(),revision=run.revision+1;
      await c.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,input.eventId,input.userId,sequence,'turn_committed',{turnId},hash]);
      for(const entry of records) {
        const r=entry.record;
        if(r.runId!==run.id||r.userId!==run.userId||r.eventId!==input.eventId||r.sequence!==sequence||r.storyVersion!==run.storyVersion||r.beatId!==run.checkpoint.beatId||r.inGameDay!==run.checkpoint.day)throw new AuthorityError('RECORD_SCOPE_MISMATCH',400);
        for(const sourceId of r.sourceIds) {const source=await c.query('SELECT id FROM memory_records WHERE run_id=$1 AND id=$2',[run.id,sourceId]);if(!source.rowCount&&!records.some(e=>e.record.id===sourceId))throw new AuthorityError('SOURCE_UNAVAILABLE',400);}
        await this.insertRecord(c,r,entry.bytes,entry.contentHash,input.bindingId,input.namespace);
      }
      await c.query('INSERT INTO turns(id,user_id,run_id,client_turn_id,expected_revision,committed_revision,request_hash,status,response,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[turnId,run.userId,run.id,input.clientTurnId,input.expectedRevision,revision,hash,'committed',input.response,input.eventId]);
      await c.query('UPDATE runs SET revision=$2,event_sequence=$3,updated_at=now() WHERE id=$1',[run.id,revision,sequence]);
      return {turnId,response:input.response,runRevision:revision,replayed:false};
    });
  }
  async insertRecord(c:pg.PoolClient,r:MemoryRecordV2,bytes:string,hash:string,bindingId?:string,namespace?:string,legacy?:unknown) {
    const lineage=[r.id,...r.sourceIds,...r.originIds,...(r.supersedesId?[r.supersedesId]:[])];if((await c.query('SELECT record_id FROM memory_tombstones WHERE user_id=$1 AND run_id=$2 AND record_id=ANY($3::text[])',[r.userId,r.runId,lineage])).rowCount)throw new AuthorityError('MEMORY_BLOCKED');
    const key=`v2:${r.id}:${hash}`;
    await c.query('INSERT INTO memory_records(id,run_id,user_id,event_id,sequence,kind,payload,payload_bytes,content_hash,representation_key,legacy_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[r.id,r.runId,r.userId,r.eventId,r.sequence,r.kind,r,bytes,hash,key,legacy??null]);
    if(bindingId&&namespace)await c.query('INSERT INTO outbox_jobs(id,user_id,run_id,record_id,event_id,account_binding_id,namespace,representation_key,payload_bytes,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),r.userId,r.runId,r.id,r.eventId,bindingId,namespace,key,bytes,hash]);
  }
  async acknowledgeTurn(input:{userId:string;runId:string;expectedRevision:number;turnId:string;clientActionId:string},advance?:(run:AuthoritativeRun,c:pg.PoolClient)=>void|Promise<void>) {
    return transaction(this.pool,async c=>{
      const run=await this.lockedRun(c,input.userId,input.runId);
      const row=await c.query('SELECT * FROM turns WHERE run_id=$1 AND id=$2 FOR UPDATE',[run.id,input.turnId]);if(!row.rowCount)throw new AuthorityError('TURN_UNAVAILABLE',404);
      if(row.rows[0].status==='acknowledged')return {run,replayed:true};
      if(run.revision!==input.expectedRevision||row.rows[0].committed_revision!==run.revision)throw new AuthorityError('REVISION_CONFLICT');
      await advance?.(run,c);const seq=run.eventSequence+1;
      await c.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,client_action_id,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[run.id,randomUUID(),run.userId,seq,'turn_acknowledged',input.clientActionId,{turnId:input.turnId},contentHash(canonicalSerialize({turnId:input.turnId}))]);
      await c.query("UPDATE turns SET status='acknowledged',acknowledged_at=now() WHERE id=$1",[input.turnId]);
      const updated=await c.query('UPDATE runs SET revision=revision+1,event_sequence=$2,checkpoint=$3,state=$4,updated_at=now() WHERE id=$1 RETURNING *',[run.id,seq,run.checkpoint,run.state]);return {run:asRun(updated.rows[0]),replayed:false};
    });
  }
  /** Explicit offline import. Retain exact source; imported cursor is blocked pending authority reconciliation. */
  async importLegacyState(state:State) {
    const migrated=migrateV1ToV2(state);const migration=migrated.memoryV2!;
    return transaction(this.pool,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(8798005)');
      const old=await c.query('SELECT source_hash FROM legacy_imports WHERE source_hash=$1',[migration.originalStateHash]);if(old.rowCount)return {replayed:true};
      for(const user of Object.values(state.users))await c.query("INSERT INTO users(id,issuer,subject,display_name) VALUES($1,'legacy-import',$1,$2) ON CONFLICT(id) DO NOTHING",[user.id,user.name]);
      for(const run of Object.values(state.runs)) {
        await c.query("INSERT INTO runs(id,user_id,story_version,revision,event_sequence,checkpoint,state,status) VALUES($1,$2,'legacy-v1',$3,$4,$5,$6,'requires_reconciliation')",[run.id,run.userId,run.revision,run.records.length,{beatId:'legacy-unreconciled',day:run.day,sceneId:'legacy',stepIndex:run.cursor,scheduleIndex:-1,phase:'dialogue'},{legacy:run}]);
        for(const [index,entry] of migration.runs[run.id].records.entries()) {
          await c.query("INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,'legacy_import',$5,$6)",[run.id,entry.record.eventId,run.userId,index+1,{recordId:entry.record.id},entry.contentHash]);
          await this.insertRecord(c,entry.record,entry.bytes,entry.contentHash,undefined,undefined,entry.legacy);
        }
      }
      await c.query('INSERT INTO legacy_imports(source_hash,source_body,limitations) VALUES($1,$2,$3)',[migration.originalStateHash,state,JSON.stringify(['Legacy issuer is not authenticated identity; reconcile ownership before access.','Client-authored day/cursor cannot become production checkpoint.','Legacy receipts remain v1 provenance, not proof of v2 bytes.'])]);return {replayed:false};
    });
  }
  async importLegacyTable() {const row=await this.pool.query('SELECT body FROM dfm_state WHERE id=1');if(!row.rowCount)throw new Error('LEGACY_STATE_MISSING');return this.importLegacyState(row.rows[0].body);}
}

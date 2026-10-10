import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { MemoryReceipt, MemoryRecordV2 } from '../domain/contracts.js';
import { canonicalSerialize, contentHash, serializeMemoryRecord, verifySerializedRecord } from '../domain/serialization.js';
import type { PostgresRepository } from '../persistence/repository.js';
import { transaction, AuthorityError } from '../persistence/transactions.js';
import { operationNamespace, type OperationScope } from './operations.js';
import { MemoryRecoveryService } from './recovery.js';

/** This value comes from an authenticated session and server Store identity map, never request JSON. */
export interface RecoveryPrincipal { userId:string; sessionId:string; identityHash:string }
type Row = Record<string, unknown>;
const tables = {
  domain_events: ['run_id','event_id','user_id','sequence','kind','client_action_id','payload','request_hash','created_at'],
  turns: ['id','user_id','run_id','client_turn_id','expected_revision','committed_revision','request_hash','status','response','event_id','acknowledged_at','created_at'],
  actor_projections: ['run_id','npc_id','revision','payload'],
  transactions: ['id','user_id','run_id','order_id','item_id','quantity','price_table_version','unit_price','paid_amount','accepted_change','state','payload'],
  evidence_edges: ['id','run_id','source_id','target_id','kind','cause_event_id','payload'],
  memory_lifecycle_operations: ['id','user_id','run_id','kind','preview','confirmation_hash','status','dispatch_count','result','created_at'],
  memory_tombstones: ['user_id','run_id','record_id','operation_id','created_at'],
  case_shares: ['id','user_id','run_id','client_action_id','request_hash','token_hash','snapshot','snapshot_hash','includes_private','created_at','expires_at','revoked_at'],
} as const;
type TableName = keyof typeof tables;
const checkpointSchema = z.object({beatId:z.string(),day:z.number().int().min(1).max(6),sceneId:z.string(),stepIndex:z.number().int().nonnegative(),scheduleIndex:z.number().int().nonnegative(),phase:z.enum(['dialogue','order','payment','complete'])}).strict();
const authoritySchema = z.object({schemaVersion:z.literal(2),kind:z.literal('dfm-authority-snapshot'),principalHash:z.string().regex(/^[a-f0-9]{64}$/),userId:z.string().min(1),runId:z.string().min(1),storyVersion:z.string().min(1),accountBindingId:z.string().min(1),accountObjectId:z.string().min(1),owner:z.string().min(1),network:z.enum(['local','mainnet']),revision:z.number().int().nonnegative(),eventSequence:z.number().int().nonnegative(),checkpoint:checkpointSchema,state:z.record(z.string(),z.unknown()),status:z.enum(['active','complete']),binding:z.record(z.string(),z.unknown()),tables:z.record(z.string(),z.array(z.record(z.string(),z.unknown()))),deletedStubs:z.array(z.record(z.string(),z.unknown())),outbox:z.array(z.record(z.string(),z.unknown())),recordIds:z.array(z.string()),recordHashes:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)),directoryGeneration:z.number().int().nonnegative().default(0),previousDirectoryHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),capturedAt:z.string(),policy:z.object({sessionsRestored:z.literal(false),delegateSecretsRestored:z.literal(false),actionTokensRestored:z.literal(false),publicSharesRevokedOnRestore:z.literal(true)}).strict()}).strict();
type AuthoritySnapshot = z.infer<typeof authoritySchema>;
const envelopeSchema = z.object({snapshot:authoritySchema,signature:z.string()}).strict();

function assertSession(state: any, principal: RecoveryPrincipal) {
  const session = state?.authV2?.sessions?.[principal.sessionId];
  if (!/^[a-f0-9]{64}$/.test(principal.identityHash) || state?.authV2?.identities?.[principal.identityHash] !== principal.userId || !session || session.userId !== principal.userId || session.revoked || session.rotated || session.accessExpiresAt <= Date.now() || !state.users?.[principal.userId]) throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
}
export function principalFromSessionState(state:any, session:{userId:string;sessionId:string}):RecoveryPrincipal {
  const keys=Object.keys(state?.authV2?.identities??{}).filter(k=>state.authV2.identities[k]===session.userId);
  if (keys.length!==1) throw new AuthorityError('RECOVERY_PRIMARY_IDENTITY_REQUIRED',403);
  const principal={...session,identityHash:keys[0]};assertSession(state,principal);return principal;
}
function safeStateKeys(value: unknown) {
  const forbidden = /^(?:accessToken|refreshToken|apiKey|privateKey|encrypted_secret|encryptedSecret|delegateSecret|sessionSecret|password)$/i;
  const walk=(v:unknown):void=>{if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(forbidden.test(k))throw new Error('RECOVERY_SECRET_FIELD_FORBIDDEN');walk(x);}};walk(value);
}
function normalizeRow(row:Row, columns:readonly string[]) { const result:Row={};for(const k of columns) if (Object.hasOwn(row,k)) result[k]=row[k]; else throw new Error('RECOVERY_ROW_COLUMN_MISSING');return result; }

export class AuthorityRecoveryService {
  constructor(private repo:PostgresRepository,private recovery:MemoryRecoveryService,private signingKey:string,private snapshotClock:()=>Date=()=>new Date(),private publicationId?:string) { if(signingKey.length<32)throw new Error('AUTHORITY_RECOVERY_SIGNING_KEY_REQUIRED'); }
  private sign(snapshot:AuthoritySnapshot) { return createHmac('sha256',this.signingKey).update('dfm-authority-v2\n'+canonicalSerialize(snapshot)).digest('base64url'); }
  private verify(raw:unknown):AuthoritySnapshot {
    const envelope=envelopeSchema.parse(raw),expected=Buffer.from(this.sign(envelope.snapshot),'base64url'),actual=Buffer.from(envelope.signature,'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new AuthorityError('RECOVERY_AUTHORITY_SIGNATURE_INVALID',403);
    const s=envelope.snapshot;safeStateKeys(s);
    if(Object.keys(s.tables).some(k=>!Object.hasOwn(tables,k))||Object.keys(tables).some(k=>!Array.isArray(s.tables[k])))throw new Error('RECOVERY_UNKNOWN_TABLE');
    for(const [name,rows]of Object.entries(s.tables))for(const row of rows){normalizeRow(row,tables[name as TableName]);if(row.run_id!==s.runId||(row.user_id!==undefined&&row.user_id!==s.userId))throw new Error('RECOVERY_AUTHORITY_ROW_SCOPE_MISMATCH');}
    const events=s.tables.domain_events;
    if(events.length!==s.eventSequence||new Set(events.map(e=>e.event_id)).size!==events.length||events.some((e,i)=>e.sequence!==i+1))throw new Error('RECOVERY_EVENT_LEDGER_INCOMPLETE');
    if(s.tables.turns.some(t=>t.status!=='acknowledged'))throw new Error('RECOVERY_UNACKNOWLEDGED_TURN');
    if(s.binding.id!==s.accountBindingId||s.binding.user_id!==s.userId||s.binding.account_id!==s.accountObjectId||s.binding.network!==s.network||s.binding.status!=='active')throw new Error('RECOVERY_BINDING_SCOPE_MISMATCH');
    if(new Set(s.recordIds).size!==s.recordIds.length)throw new Error('RECOVERY_RECORD_IDS_DUPLICATED');
    return s;
  }
  async publish(scope:OperationScope,principal:RecoveryPrincipal) {
    if(principal.userId!==scope.userId)throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
    const captured=await transaction(this.repo.pool,async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const run=await this.repo.lockedRun(c,scope.userId,scope.runId);
      if(run.revision!==scope.revision)throw new AuthorityError('REVISION_CONFLICT');
      const auth=(await c.query('SELECT body FROM dfm_state WHERE id=1')).rows[0]?.body;assertSession(auth,principal);
      if(this.publicationId){
        const job=(await c.query('SELECT * FROM authority_backup_jobs WHERE id=$1 AND user_id=$2 AND run_id=$3 FOR UPDATE',[this.publicationId,scope.userId,scope.runId])).rows[0];
        if(!job||job.principal_hash!==principal.identityHash||job.revision!==scope.revision||job.binding_id!==scope.accountBindingId||canonicalSerialize(job.scope)!==canonicalSerialize(scope))throw new AuthorityError('RECOVERY_BACKUP_SCOPE_MISMATCH',403);
        if(job.captured){
          const cached=job.captured;authoritySchema.parse(cached.snapshot);safeStateKeys(cached);
          if(cached.snapshot.userId!==scope.userId||cached.snapshot.runId!==scope.runId||cached.snapshot.principalHash!==principal.identityHash)throw new AuthorityError('RECOVERY_BACKUP_SCOPE_MISMATCH',403);
          return cached as {snapshot:AuthoritySnapshot;records:{bytes:string;receipt:MemoryReceipt}[];tombstoneIds:string[]};
        }
      }
      const binding=(await c.query("SELECT to_jsonb(b) row FROM account_bindings b WHERE id=$1 AND user_id=$2 AND status='active'",[scope.accountBindingId,scope.userId])).rows[0]?.row;
      if(!binding||binding.account_id!==scope.accountObjectId||binding.network!==scope.network)throw new AuthorityError('RECOVERY_BINDING_SCOPE_MISMATCH');
      if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed'",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
      if((await c.query("SELECT id FROM outbox_jobs WHERE run_id=$1 AND (lease_token IS NOT NULL OR state NOT IN ('retrievable','permanent_failure')) AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.run_id=outbox_jobs.run_id AND t.record_id=outbox_jobs.record_id)",[run.id])).rowCount)throw new AuthorityError('RECOVERY_OUTBOX_IN_FLIGHT');
      for(const name of ['memory_operations','memory_lifecycle_operations','ownership_migrations'] as const){
        const exists=(await c.query('SELECT to_regclass($1) name',[name])).rows[0]?.name;
        if(exists&&(await c.query(`SELECT 1 FROM ${name} WHERE run_id=$1 AND status IN ('queued','dispatched','requested','executing','unknown','partial') LIMIT 1`,[run.id])).rowCount)throw new AuthorityError('RECOVERY_EXTERNAL_OPERATION_IN_FLIGHT');
      }
      const data:Record<string,Row[]>={};
      for(const name of Object.keys(tables) as TableName[]){
        if(!(await c.query('SELECT to_regclass($1) name',[name])).rows[0]?.name){data[name]=[];continue;}
        data[name]=(await c.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE run_id=$1 ORDER BY ${name==='domain_events'?'sequence':name==='actor_projections'?'npc_id':name==='memory_tombstones'?'record_id':'id'}`,[run.id])).rows.map(r=>normalizeRow(r.row,tables[name]));
      }
      const tombstoneIds=data.memory_tombstones.map(t=>t.record_id as string),denied=new Set(tombstoneIds);
      const rawRecords=(await c.query(`SELECT m.payload_bytes,m.content_hash,m.payload,r.receipt FROM memory_records m LEFT JOIN memory_receipts r ON r.record_id=m.id AND r.account_binding_id=$2 AND r.namespace=$3 AND r.state='retrievable' WHERE m.run_id=$1 ORDER BY m.sequence,m.id`,[run.id,scope.accountBindingId,operationNamespace(scope)])).rows;
      // Close over deleted ancestry before serializing the authority bundle; no deleted prose gets copied into snapshots.
      let changed=true;while(changed){changed=false;for(const r of rawRecords){const record=verifySerializedRecord(r.payload_bytes,r.content_hash);if(!denied.has(record.id)&&[...record.sourceIds,...record.originIds,...(record.supersedesId?[record.supersedesId]:[])].some(id=>denied.has(id))){denied.add(record.id);changed=true;}}}
      for(const id of denied)if(!tombstoneIds.includes(id)){const fence=data.memory_tombstones[0];if(!fence)throw new Error('RECOVERY_TOMBSTONE_CAUSE_REQUIRED');data.memory_tombstones.push({...fence,record_id:id});tombstoneIds.push(id);}
      const records=rawRecords.filter(r=>!denied.has(r.payload.id));if(records.some(r=>!r.receipt))throw new AuthorityError('MANIFEST_RECORD_NOT_RETRIEVABLE');
      const deletedStubs=rawRecords.filter(r=>denied.has(r.payload.id)).map(r=>{
        const original=r.payload as MemoryRecordV2;
        return {...original,actor:'system',kind:'interpretation',epistemicStatus:'hypothesized',text:'[deleted memory]',sourceIds:[],originIds:[original.id],entityIds:[],propositionIds:[],recipients:[],...(original.supersedesId?{supersedesId:undefined}:{})};
      }).map(r=>{const {supersedesId,...safe}=r;return safe;});
      const redactedEvents=new Set(rawRecords.filter(r=>denied.has(r.payload.id)).map(r=>r.payload.eventId));
      for(const event of data.domain_events)if(redactedEvents.has(event.event_id as string))event.payload={redacted:true,reason:'memory_tombstone',result:{record:{id:rawRecords.find(r=>denied.has(r.payload.id)&&r.payload.eventId===event.event_id)!.payload.id},promiseEvents:[],taskEvents:[]}};
      for(const turn of data.turns)if(redactedEvents.has(turn.event_id as string))turn.response={redacted:true};
      data.evidence_edges=data.evidence_edges.filter(e=>!denied.has(e.source_id as string)&&!denied.has(e.target_id as string));
      data.actor_projections=[]; // Rebuilt lazily from verified records; stale known-source payloads cannot survive deletion.
      for(const share of data.case_shares){share.revoked_at=this.snapshotClock().toISOString();share.snapshot={recoveredRevoked:true};share.snapshot_hash=contentHash(canonicalSerialize(share.snapshot));}
      for(const operation of data.memory_lifecycle_operations){operation.preview={recovered:true};operation.result={restoredMetadataOnly:true};}
      const outbox=(await c.query('SELECT to_jsonb(j) row FROM outbox_jobs j WHERE run_id=$1 AND account_binding_id=$2 ORDER BY id',[run.id,scope.accountBindingId])).rows.filter(r=>!denied.has(r.row.record_id)).map(r=>{const {payload_bytes,lease_token,lease_expires_at,...metadata}=r.row;return metadata;});
      const snapshot=authoritySchema.parse({schemaVersion:2,kind:'dfm-authority-snapshot',principalHash:principal.identityHash,userId:run.userId,runId:run.id,storyVersion:run.storyVersion,accountBindingId:scope.accountBindingId,accountObjectId:scope.accountObjectId,owner:scope.owner,network:scope.network,revision:run.revision,eventSequence:run.eventSequence,checkpoint:run.checkpoint,state:run.state,status:run.status,binding,tables:data,deletedStubs,outbox,recordIds:records.map(r=>r.payload.id),recordHashes:Object.fromEntries(records.map(r=>[r.payload.id,r.content_hash])),capturedAt:this.snapshotClock().toISOString(),policy:{sessionsRestored:false,delegateSecretsRestored:false,actionTokensRestored:false,publicSharesRevokedOnRestore:true}});
      safeStateKeys(snapshot);
      const result={snapshot,records:records.map(r=>({bytes:r.payload_bytes as string,receipt:r.receipt as MemoryReceipt})),tombstoneIds};
      if(this.publicationId)await c.query('UPDATE authority_backup_jobs SET captured=$2 WHERE id=$1',[this.publicationId,result]);
      return result;
    });
    let head:Awaited<ReturnType<MemoryRecoveryService['discover']>>|undefined;
    try{head=await this.recovery.discover(scope);}catch(e){if(!(e instanceof Error)||e.message!=='RECOVERY_DIRECTORY_UNAVAILABLE')throw e;}
    if(head?.directory.authority && this.publicationId){
      const old=this.verify(await this.recovery.readAuthority(scope,head.directory));
      const comparable={...captured.snapshot,directoryGeneration:head.directory.generation,...(head.directory.previous?{previousDirectoryHash:head.directory.previous.contentHash}:{})};
      if(canonicalSerialize(old)===canonicalSerialize(comparable))return head;
    }
    captured.snapshot.directoryGeneration=head?head.directory.generation+1:0;
    if(head)captured.snapshot.previousDirectoryHash=head.anchor.contentHash;
    const authorityBytes=canonicalSerialize({snapshot:captured.snapshot,signature:this.sign(captured.snapshot)});
    const published=await this.recovery.publish(scope,{storyVersion:captured.snapshot.storyVersion,generation:head?head.directory.generation+1:0,...(head?{previous:head.anchor}:{}),records:captured.records,tombstoneIds:captured.tombstoneIds,authorityBytes});
    const actual=await this.recovery.discover(scope);if(actual.anchor.contentHash!==published.anchor.contentHash)throw new AuthorityError('MANIFEST_HEAD_CHANGED');
    return published;
  }
  async restore(scope:OperationScope,principal:RecoveryPrincipal) {
    const head=await this.recovery.discover(scope),snapshot=this.verify(await this.recovery.readAuthority(scope,head.directory));
    if(snapshot.directoryGeneration!==head.directory.generation||snapshot.previousDirectoryHash!==head.directory.previous?.contentHash)throw new AuthorityError('RECOVERY_AUTHORITY_HEAD_MISMATCH');
    if(snapshot.userId!==scope.userId||snapshot.runId!==scope.runId||snapshot.accountBindingId!==scope.accountBindingId||snapshot.accountObjectId!==scope.accountObjectId||snapshot.owner!==scope.owner||snapshot.network!==scope.network||snapshot.principalHash!==principal.identityHash)throw new AuthorityError('RECOVERY_AUTHORITY_SCOPE_MISMATCH',403);
    const recovered=await this.recovery.rebuild(scope,head.anchor,snapshot.storyVersion);
    if(recovered.projectionReadOnly||canonicalSerialize([...snapshot.recordIds].sort())!==canonicalSerialize(recovered.records.map(r=>r.id).sort()))throw new AuthorityError('RECOVERY_AUTHORITY_RECORD_SET_INCOMPLETE');
    if(Object.keys(snapshot.recordHashes).length!==snapshot.recordIds.length||recovered.records.some(r=>snapshot.recordHashes[r.id]!==serializeMemoryRecord(r).contentHash))throw new AuthorityError('RECOVERY_AUTHORITY_RECORD_HASH_MISMATCH');
    if(canonicalSerialize([...head.directory.tombstoneIds].sort())!==canonicalSerialize(snapshot.tables.memory_tombstones.map(t=>t.record_id as string).sort()))throw new AuthorityError('RECOVERY_AUTHORITY_TOMBSTONE_MISMATCH');
    return transaction(this.repo.pool,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(8798001)');
      const stored=(await c.query('SELECT body FROM dfm_state WHERE id=1 FOR UPDATE')).rows[0]?.body;assertSession(stored,principal);
      if((await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[scope.runId])).rowCount)throw new AuthorityError('RECOVERY_RUN_ALREADY_EXISTS');
      // No restore over a newer run, no merging stale deletion state; target run must be absent.
      if((await c.query('SELECT 1 FROM memory_tombstones WHERE run_id=$1 LIMIT 1',[scope.runId])).rowCount)throw new AuthorityError('RECOVERY_EXISTING_TOMBSTONE_FENCE');
      await this.adoptIdentity(c,stored,principal,scope.userId);
      let bindingPayload=snapshot.binding.payload;
      if(snapshot.binding.mode==='personal'){
        // Historical delegate/grant metadata cannot authorize current writes. A new owner proof/grant must already exist.
        const personal=(await c.query("SELECT id,address FROM personal_memory_accounts WHERE user_id=$1 AND account_id=$2 AND status='delegate_granted' FOR UPDATE",[scope.userId,scope.accountObjectId])).rows[0];
        if(!personal||personal.address!==scope.owner)throw new AuthorityError('RECOVERY_PERSONAL_REBIND_REQUIRED',403);
        bindingPayload={...(bindingPayload as Row),personalAccountId:personal.id};
      }
      const existingBinding=(await c.query('SELECT * FROM account_bindings WHERE id=$1 FOR UPDATE',[scope.accountBindingId])).rows[0];
      if(existingBinding&&(existingBinding.user_id!==scope.userId||existingBinding.account_id!==scope.accountObjectId||existingBinding.network!==scope.network||existingBinding.mode!==snapshot.binding.mode||existingBinding.status!=='active'))throw new AuthorityError('RECOVERY_BINDING_SCOPE_MISMATCH');
      if(!existingBinding)await c.query('INSERT INTO account_bindings(id,user_id,network,mode,account_id,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[scope.accountBindingId,scope.userId,scope.network,snapshot.binding.mode,scope.accountObjectId,'active',bindingPayload]);
      await c.query('INSERT INTO runs(id,user_id,story_version,revision,event_sequence,checkpoint,state,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[scope.runId,scope.userId,snapshot.storyVersion,snapshot.revision,snapshot.eventSequence,snapshot.checkpoint,snapshot.state,snapshot.status]);
      await this.insertRows(c,'domain_events',snapshot.tables.domain_events);
      const records=[...recovered.records,...snapshot.deletedStubs as unknown as MemoryRecordV2[]];
      for(const record of records){const serialized=serializeMemoryRecord(record);await c.query('INSERT INTO memory_records(id,run_id,user_id,event_id,sequence,kind,payload,payload_bytes,content_hash,representation_key,legacy_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[record.id,record.runId,record.userId,record.eventId,record.sequence,record.kind,record,serialized.bytes,serialized.contentHash,`v2:${record.id}:${serialized.contentHash}`,snapshot.deletedStubs.some(r=>r.id===record.id)?{recoveredDeletedStub:true}:null]);}
      for(const name of ['turns','transactions','evidence_edges','memory_lifecycle_operations','case_shares','memory_tombstones'] as TableName[])await this.insertRows(c,name,snapshot.tables[name]);
      for(const receipt of recovered.receipts)await c.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,\'retrievable\',$4,$5)',[receipt.recordId,scope.accountBindingId,receipt.namespace,receipt.contentHash,receipt]);
      const recoveredIds=new Set(recovered.records.map(r=>r.id));
      for(const chunk of snapshot.outbox){
        if(!recoveredIds.has(chunk.record_id as string))throw new Error('RECOVERY_OUTBOX_RECORD_MISMATCH');
        const record=recovered.records.find(r=>r.id===chunk.record_id)!,serial=serializeMemoryRecord(record),receipt=chunk.receipt as MemoryReceipt;
        if(!receipt||receipt.state!=='retrievable'||receipt.contentHash!==serial.contentHash||receipt.accountBindingId!==scope.accountBindingId||receipt.namespace!==operationNamespace(scope))throw new Error('RECOVERY_OUTBOX_RECEIPT_MISMATCH');
        await c.query('INSERT INTO outbox_jobs(id,user_id,run_id,record_id,event_id,account_binding_id,namespace,representation_key,payload_bytes,content_hash,state,accepted_job_id,receipt,attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'retrievable\',$11,$12,$13)',[chunk.id,scope.userId,scope.runId,record.id,record.eventId,scope.accountBindingId,receipt.namespace,`v2:${record.id}:${serial.contentHash}`,serial.bytes,serial.contentHash,chunk.accepted_job_id,receipt,chunk.attempts]);
      }
      // Receipts not originating from an outbox (e.g. imported/migrated records) are also authoritative manifest entries.
      await c.query('UPDATE dfm_state SET body=$1 WHERE id=1',[stored]);
      return {restored:true as const,playable:true as const,userId:scope.userId,runId:scope.runId,revision:snapshot.revision,recordCount:recovered.records.length,tombstones:head.directory.tombstoneIds,head:head.anchor,sessionsRestored:false as const,ownershipSecretsRestored:false as const,checkpoint:snapshot.checkpoint};
    });
  }
  /** Optional two-step personal recovery: restore authenticated identity first, then create a fresh owner proof/delegate grant. */
  async adoptIdentityForRecovery(scope:OperationScope,principal:RecoveryPrincipal) {
    const head=await this.recovery.discover(scope),snapshot=this.verify(await this.recovery.readAuthority(scope,head.directory));
    if(snapshot.directoryGeneration!==head.directory.generation||snapshot.previousDirectoryHash!==head.directory.previous?.contentHash)throw new AuthorityError('RECOVERY_AUTHORITY_HEAD_MISMATCH');
    if(snapshot.principalHash!==principal.identityHash||snapshot.userId!==scope.userId||snapshot.runId!==scope.runId||snapshot.accountObjectId!==scope.accountObjectId||snapshot.accountBindingId!==scope.accountBindingId||snapshot.owner!==scope.owner||snapshot.network!==scope.network)throw new AuthorityError('RECOVERY_AUTHORITY_SCOPE_MISMATCH',403);
    return transaction(this.repo.pool,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(8798001)');const state=(await c.query('SELECT body FROM dfm_state WHERE id=1 FOR UPDATE')).rows[0]?.body;assertSession(state,principal);
      if((await c.query('SELECT id FROM runs WHERE id=$1',[scope.runId])).rowCount)throw new AuthorityError('RECOVERY_RUN_ALREADY_EXISTS');
      await this.adoptIdentity(c,state,principal,scope.userId);await c.query('UPDATE dfm_state SET body=$1 WHERE id=1',[state]);
      return {identityAdopted:true as const,userId:scope.userId,playable:false as const,sessionsRestored:false as const,next:snapshot.binding.mode==='personal'?'fresh_owner_proof_and_delegate_grant' as const:'restore_verified_authority' as const};
    });
  }
  private async insertRows(c:pg.PoolClient,name:TableName,rows:Row[]) {for(const row of rows){const columns=tables[name];await c.query(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(k=>row[k]));}}
  private async adoptIdentity(c:pg.PoolClient,state:any,principal:RecoveryPrincipal,targetUserId:string) {
    if(principal.userId!==targetUserId){
      if(state.users[targetUserId]||Object.values(state.runs??{}).some((r:any)=>r.userId===principal.userId)||(await c.query('SELECT 1 FROM runs WHERE user_id=$1 UNION ALL SELECT 1 FROM account_bindings WHERE user_id=$1 LIMIT 1',[principal.userId])).rowCount)throw new AuthorityError('RECOVERY_IDENTITY_ADOPTION_NOT_EMPTY');
      if((await c.query("SELECT to_regclass('personal_memory_accounts') name")).rows[0]?.name&&(await c.query('SELECT 1 FROM personal_memory_accounts WHERE user_id=$1 LIMIT 1',[principal.userId])).rowCount)throw new AuthorityError('RECOVERY_IDENTITY_ADOPTION_NOT_EMPTY');
      if((await c.query('SELECT id FROM users WHERE id=$1',[targetUserId])).rowCount)throw new AuthorityError('RECOVERY_TARGET_IDENTITY_EXISTS');
      const current=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[principal.userId])).rows[0];if(!current)throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
      // Only the already active fresh sessions are remapped; no historical credentials enter the backup.
      state.users[targetUserId]={...state.users[principal.userId],id:targetUserId};delete state.users[principal.userId];
      for(const [key,userId]of Object.entries(state.authV2.identities))if(userId===principal.userId)state.authV2.identities[key]=targetUserId;
      for(const session of Object.values(state.authV2.sessions) as any[])if(session.userId===principal.userId)session.userId=targetUserId;
      await c.query('UPDATE users SET id=$2,subject=CASE WHEN issuer=\'session-store\' THEN $2 ELSE subject END WHERE id=$1',[principal.userId,targetUserId]);
    } else if(!(await c.query('SELECT id FROM users WHERE id=$1',[targetUserId])).rowCount)throw new AuthorityError('RECOVERY_PRINCIPAL_INVALID',403);
  }
}

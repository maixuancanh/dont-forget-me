import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { AuthorityRecoveryService, type RecoveryPrincipal } from '../src/memory/authority-recovery.js';
import { MemoryRecoveryService, type ExactRecoveryStore, type RecoveryAnchor } from '../src/memory/recovery.js';
import { operationNamespace } from '../src/memory/operations.js';
import { serializeMemoryRecord, contentHash } from '../src/domain/serialization.js';
import type { MemoryRecordV2, MemoryReceipt } from '../src/domain/contracts.js';
import { GameplayService } from '../src/gameplay/service.js';
import { AuthorityBackupService } from '../src/memory/authority-backup.js';
import { Store } from '../src/store.js';
import { SessionService } from '../src/auth/session.js';
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';assertTestDatabase(database);
const admin=new pg.Pool({connectionString:database}),pools:pg.Pool[]=[],schemas:string[]=[],stores:Store[]=[];
beforeAll(async()=>{await admin.query('SELECT 1');});
afterAll(async()=>{for(const s of stores)await s.close();for(const p of pools)await p.end();for(const name of schemas){if(!/^authority_[a-f0-9]{32}$/.test(name))throw new Error('INVALID_TEST_SCHEMA');await admin.query(`DROP SCHEMA ${name} CASCADE`);}await admin.end();});
async function isolated() {
  const schema='authority_'+randomUUID().replaceAll('-','');schemas.push(schema);await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema},public`,max:2});pools.push(pool);const repo=new PostgresRepository(pool);await repo.migrate();
  for(const name of ['002_memory_operations.sql','003_case_shares.sql','005_personal_accounts.sql','006_ownership_migration.sql'])await pool.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await pool.query('CREATE TABLE dfm_state(id integer PRIMARY KEY,body jsonb NOT NULL)');
  return {schema,pool,repo};
}
async function auth(db:Awaited<ReturnType<typeof isolated>>,identityHash:string,userId=randomUUID()) {
  const sessionId=randomUUID(),accessToken=Buffer.from(randomUUID()+randomUUID()).subarray(0,32).toString('base64url');
  const body={users:{[userId]:{id:userId,name:'Recovery test'}},runs:{},localMemories:{},authV2:{identities:{[identityHash]:userId},sessions:{[sessionId]:{id:sessionId,familyId:randomUUID(),userId,accessDigest:createHash('sha256').update(accessToken).digest('hex'),refreshDigest:'fixture-only',accessExpiresAt:Date.now()+600000,refreshExpiresAt:Date.now()+1000000,rotated:false,revoked:false}}}};
  await db.pool.query("INSERT INTO users(id,issuer,subject) VALUES($1,'session-store',$1)",[userId]);await db.pool.query('INSERT INTO dfm_state VALUES(1,$1)',[body]);
  return {principal:{userId,sessionId,identityHash} satisfies RecoveryPrincipal,accessToken};
}
async function fixture(deleted=false) {
  const source=await isolated(),target=await isolated(),identityHash=createHash('sha256').update(JSON.stringify(['issuer',randomUUID()])).digest('hex');
  const sourceAuth=await auth(source,identityHash),targetAuth=await auth(target,identityHash),userId=sourceAuth.principal.userId;
  const run=await source.repo.createRun({userId,storyVersion:'v',initialCheckpoint:{beatId:'b',day:2,sceneId:'scene',stepIndex:1,scheduleIndex:2,phase:'dialogue'}}),bindingId=randomUUID();
  const state={physicalObjects:{instances:[{instanceId:'receipt-physical',itemId:'coffee',quantity:1,status:'carried'}],heldInstanceId:'receipt-physical'},relationshipCauses:[],changedOrders:{}};
  await source.pool.query("INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,'local','local','local-test-account')",[bindingId,userId]);
  const eventId=randomUUID(),recordId=randomUUID(),scope={userId,runId:run.id,revision:1,accountBindingId:bindingId,accountObjectId:'local-test-account',owner:'owner',network:'local' as const};
  await source.pool.query("INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,client_action_id,payload,request_hash) VALUES($1,$2,$3,1,'fixture_observation','fixture-action',$4,'fixture')",[run.id,eventId,userId,{note:'Original unique phrase'}]);
  const record:MemoryRecordV2={schemaVersion:2,id:recordId,eventId,userId,runId:run.id,sessionId:'original-session',sequence:1,storyVersion:'v',beatId:'b',inGameDay:1,createdAt:'2026-10-10T00:00:00Z',actor:'player',kind:'hypothesis',text:'Original unique phrase',epistemicStatus:'hypothesized',sourceIds:[],originIds:[recordId],recipients:['player'],entityIds:[],propositionIds:[]};
  const serial=serializeMemoryRecord(record),client=await source.pool.connect();try{await source.repo.insertRecord(client,record,serial.bytes,serial.contentHash,bindingId,operationNamespace(scope));}finally{client.release();}
  const receipt:MemoryReceipt={recordId,contentHash:serial.contentHash,blobId:'original-blob',accountBindingId:bindingId,namespace:operationNamespace(scope),network:'local',state:'retrievable',verifiedAt:new Date().toISOString()};
  await source.pool.query("INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,'retrievable',$4,$5)",[recordId,bindingId,receipt.namespace,receipt.contentHash,receipt]);
  await source.pool.query("UPDATE outbox_jobs SET state='retrievable',receipt=$2,accepted_job_id='original-job' WHERE run_id=$1",[run.id,receipt]);
  await source.pool.query('UPDATE runs SET revision=1,event_sequence=1,state=$2 WHERE id=$1',[run.id,state]);
  await source.pool.query("INSERT INTO transactions(id,user_id,run_id,order_id,item_id,quantity,price_table_version,unit_price,paid_amount,accepted_change,state) VALUES($1,$2,$3,'order-1','coffee',1,'price-v1',20000,50000,30000,'settled')",[randomUUID(),userId,run.id]);
  if(deleted){const id=randomUUID();await source.pool.query("INSERT INTO memory_lifecycle_operations(id,user_id,run_id,kind,preview,confirmation_hash,status,dispatch_count) VALUES($1,$2,$3,'delete','{}','fixture','confirmed',1)",[id,userId,run.id]);await source.pool.query('INSERT INTO memory_tombstones(user_id,run_id,record_id,operation_id) VALUES($1,$2,$3,$4)',[userId,run.id,recordId,id]);}
  const bytes=new Map<string,string>([['original-blob',serial.bytes]]),anchors:RecoveryAnchor[]=[];
  const store:ExactRecoveryStore={directory:async()=>({anchors,complete:true}),read:async(_scope,a)=>{const value=bytes.get(a.blobId);if(value===undefined)throw new Error('REMOTE_BLOB_UNAVAILABLE');return value;},write:async(_scope,ns,b)=>{const a={blobId:contentHash(b),contentHash:contentHash(b)};bytes.set(a.blobId,b);if(ns.endsWith(':directory'))anchors.push(a);return a;}};
  const recovery=new MemoryRecoveryService(store),key='fixture-authority-key-at-least-32-characters',publisher=new AuthorityRecoveryService(source.repo,recovery,key),restorer=new AuthorityRecoveryService(target.repo,recovery,key);
  const published=await publisher.publish(scope,sourceAuth.principal);
  return {source,target,scope,sourceAuth,targetAuth,publisher,restorer,published,bytes,record,state,recovery,key};
}
it('fresh empty authority DB restores checkpoint, inventory, ledger, commerce, receipts; active login adopts identity and gameplay continues',async()=>{
  const f=await fixture(),result=await f.restorer.restore(f.scope,f.targetAuth.principal);expect(result.playable).toBe(true);
  const run=await f.target.repo.getRun(f.scope.userId,f.scope.runId);expect(run.state).toEqual(f.state);expect(run.checkpoint).toEqual(result.checkpoint);expect(run.eventSequence).toBe(1);
  expect((await f.target.pool.query('SELECT paid_amount,accepted_change,state FROM transactions WHERE run_id=$1',[run.id])).rows[0]).toEqual({paid_amount:50000,accepted_change:30000,state:'settled'});
  expect((await f.target.pool.query('SELECT state,lease_token FROM outbox_jobs WHERE run_id=$1',[run.id])).rows[0]).toEqual({state:'retrievable',lease_token:null});
  const url=new URL(database);url.searchParams.set('options',`-c search_path=${f.target.schema},public`);const sessionStore=new Store('unused-recovery-test',url.toString());stores.push(sessionStore);
  const current=await new SessionService(sessionStore).authenticate(f.targetAuth.accessToken);expect(current.userId).toBe(f.scope.userId);
  const gameplay=new GameplayService(f.target.repo,async()=>({id:f.scope.accountBindingId,namespace:operationNamespace(f.scope),network:'local'}));
  const action={kind:'note' as const,text:'A new thought after recovery',recordIds:[f.record.id]},preview=await gameplay.preview(current.userId,run.id,action);
  const saved=await gameplay.commit(current.userId,current.sessionId,run.id,{expectedRevision:preview.revision,clientActionId:randomUUID(),consentHash:preview.consentHash,action});expect(saved.run.revision).toBe(2);expect(saved.result.record.sourceIds).toEqual([f.record.id]);
});
it('deleted prose is absent from new authority snapshot and restores only hidden tombstone stub',async()=>{
  const f=await fixture(true),raw=f.bytes.get(f.published.directory.authority!.blobId)!;expect(raw).not.toContain('Original unique phrase');
  const restored=await f.restorer.restore(f.scope,f.targetAuth.principal);expect(restored.recordCount).toBe(0);
  expect((await f.target.pool.query('SELECT record_id FROM memory_tombstones WHERE run_id=$1',[f.scope.runId])).rows[0].record_id).toBe(f.record.id);
  const payload=(await f.target.pool.query('SELECT payload FROM memory_records WHERE id=$1',[f.record.id])).rows[0].payload;expect(payload.text).toBe('[deleted memory]');
});
it('rejects wrong current principal and signature, leaves target DB empty',async()=>{
  const f=await fixture();await expect(f.restorer.restore(f.scope,{...f.targetAuth.principal,identityHash:'a'.repeat(64)})).rejects.toThrow('SCOPE_MISMATCH');
  const wrong=new AuthorityRecoveryService(f.target.repo,f.recovery,'different-fixture-signing-key-at-least-32');await expect(wrong.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('SIGNATURE');
  expect((await f.target.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(0);
});
it('refuses existing target run, nonempty identity adoption and absent original source',async()=>{
  const f=await fixture();await f.target.repo.createRun({userId:f.targetAuth.principal.userId,storyVersion:'v',initialCheckpoint:{beatId:'b',day:1,sceneId:'scene',stepIndex:0,scheduleIndex:0,phase:'dialogue'}});
  await expect(f.restorer.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('ADOPTION_NOT_EMPTY');
  f.bytes.delete('original-blob');await expect(f.restorer.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('RECORD_SET_INCOMPLETE');
});
it('refuses snapshot while canonical outbox or turn is in flight',async()=>{
  const f=await fixture();await f.source.pool.query("UPDATE outbox_jobs SET state='queued' WHERE run_id=$1",[f.scope.runId]);await expect(f.publisher.publish(f.scope,f.sourceAuth.principal)).rejects.toThrow('OUTBOX_IN_FLIGHT');
});
it('personal recovery requires fresh owner grant after identity adoption, never restores old delegate secret',async()=>{
  const f=await fixture();await f.source.pool.query("UPDATE account_bindings SET mode='personal',payload=$2 WHERE id=$1",[f.scope.accountBindingId,{personalAccountId:'historical-delegate-id'}]);
  const published=await f.publisher.publish(f.scope,f.sourceAuth.principal);expect(f.bytes.get(published.directory.authority!.blobId)).not.toContain('encrypted_secret');
  await expect(f.restorer.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('PERSONAL_REBIND_REQUIRED');
  expect(await f.restorer.adoptIdentityForRecovery(f.scope,f.targetAuth.principal)).toMatchObject({identityAdopted:true,playable:false});
  const personalId=randomUUID();await f.target.pool.query("INSERT INTO personal_memory_accounts(id,user_id,account_id,address,public_key,encrypted_secret,status,grant_digest) VALUES($1,$2,$3,'owner','fixture-public-key','new-fixture-secret','delegate_granted','fresh-fixture-grant')",[personalId,f.scope.userId,f.scope.accountObjectId]);
  const principal={...f.targetAuth.principal,userId:f.scope.userId};expect(await f.restorer.restore(f.scope,principal)).toMatchObject({playable:true});
  const binding=(await f.target.pool.query('SELECT payload FROM account_bindings WHERE id=$1',[f.scope.accountBindingId])).rows[0];expect(binding.payload.personalAccountId).toBe(personalId);
});
it('any existing target run and revoked current session fail before importing a historical run',async()=>{
  const f=await fixture();await f.target.repo.createRun({id:f.scope.runId,userId:f.targetAuth.principal.userId,storyVersion:'v',initialCheckpoint:{beatId:'b',day:1,sceneId:'s',stepIndex:0,scheduleIndex:0,phase:'dialogue'}});
  await expect(f.restorer.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('RUN_ALREADY_EXISTS');
  const other=await fixture(),row=(await other.target.pool.query('SELECT body FROM dfm_state WHERE id=1')).rows[0];row.body.authV2.sessions[other.targetAuth.principal.sessionId].revoked=true;await other.target.pool.query('UPDATE dfm_state SET body=$1 WHERE id=1',[row.body]);
  await expect(other.restorer.restore(other.scope,other.targetAuth.principal)).rejects.toThrow('PRINCIPAL_INVALID');
});
it('cannot repoint a newer directory generation at an older correctly signed authority snapshot',async()=>{
  const f=await fixture(),receipt=(await f.source.pool.query('SELECT receipt FROM memory_receipts WHERE record_id=$1',[f.record.id])).rows[0].receipt;
  await f.recovery.publish(f.scope,{storyVersion:'v',generation:1,previous:f.published.anchor,records:[{bytes:f.bytes.get('original-blob')!,receipt}],tombstoneIds:[],authorityBytes:f.bytes.get(f.published.directory.authority!.blobId)!});
  await expect(f.restorer.restore(f.scope,f.targetAuth.principal)).rejects.toThrow('AUTHORITY_HEAD_MISMATCH');
  expect((await f.target.pool.query('SELECT count(*)::int n FROM runs')).rows[0].n).toBe(0);
});
it('durable backup resumes a published-but-unacknowledged job without publishing another head',async()=>{
 const f=await fixture();let calls=0;
 const first=new AuthorityBackupService(f.source.repo,async(scope,principal,id,clock)=>{
  calls++;await new AuthorityRecoveryService(f.source.repo,f.recovery,f.key,()=>clock,id).publish(scope,principal);
  throw Error('SIMULATED_DISCONNECT');
 });await first.migrate();
 const requested=await first.request(f.scope,f.sourceAuth.principal);await first.drain();
 const head=await f.recovery.discover(f.scope);expect(head.directory.generation).toBe(1);
 const second=new AuthorityBackupService(f.source.repo,(scope,principal,id,clock)=>new AuthorityRecoveryService(f.source.repo,f.recovery,f.key,()=>clock,id).publish(scope,principal));
 expect((await second.status(f.scope.userId,f.scope.runId,requested.operationId,f.sourceAuth.principal)).status).toBe('retry');await second.drain();
 const completed=await second.status(f.scope.userId,f.scope.runId,requested.operationId,f.sourceAuth.principal);
 expect(completed.status).toBe('complete');expect((completed.result as any).anchor).toEqual(head.anchor);
 expect((await f.recovery.discover(f.scope)).directory.generation).toBe(1);expect(calls).toBe(1);
 const again=await second.request(f.scope,f.sourceAuth.principal);expect(again.operationId).toBe(requested.operationId);expect(again.status).toBe('complete');
 await expect(second.status('foreign-user',f.scope.runId,requested.operationId,{...f.sourceAuth.principal,userId:'foreign-user'})).rejects.toThrow('FORBIDDEN');
 await expect(second.request({...f.scope,owner:'foreign-owner'},f.sourceAuth.principal)).rejects.toThrow('PRINCIPAL_INVALID');
});
it('concurrent backup requests share one scoped operation and a single remote dispatch',async()=>{
 const f=await fixture();let dispatches=0;
 const service=new AuthorityBackupService(f.source.repo,async()=>{dispatches++;await new Promise(resolve=>setTimeout(resolve,30));return {fixture:true};});await service.migrate();
 const jobs=await Promise.all([service.request(f.scope,f.sourceAuth.principal),service.request(f.scope,f.sourceAuth.principal)]);await service.drain();
 expect(jobs[0]!.operationId).toBe(jobs[1]!.operationId);expect(dispatches).toBe(1);
 await expect(service.status(f.scope.userId,f.scope.runId,jobs[0]!.operationId,{...f.sourceAuth.principal,identityHash:'0'.repeat(64)})).rejects.toThrow('FORBIDDEN');
});
it('retains safe upload diagnostics across retry without exposing raw provider errors',async()=>{
 const f=await fixture(),jobId=randomUUID();
 const service=new AuthorityBackupService(f.source.repo,async()=>{throw Object.assign(Error('private credential upstream URL'),{jobId});});await service.migrate();
 const job=await service.request(f.scope,f.sourceAuth.principal);await service.drain();
 const row=(await f.source.pool.query('SELECT error_code,upstream_job_id,attempt_count FROM authority_backup_jobs WHERE id=$1',[job.operationId])).rows[0];
 expect(row).toEqual({error_code:'BACKUP_STORAGE_PENDING',upstream_job_id:jobId,attempt_count:1});
 const next=await service.status(f.scope.userId,f.scope.runId,job.operationId,f.sourceAuth.principal);await service.drain();
 expect(next.error).toBe('BACKUP_STORAGE_PENDING');expect(JSON.stringify(next)).not.toContain('private credential');
});

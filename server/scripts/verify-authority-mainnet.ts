import {MemWal} from '@mysten-incubation/memwal';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import pg from 'pg';
import {config} from '../src/config.js';
import {PostgresRepository} from '../src/persistence/repository.js';
import {AuthorityRecoveryService,type RecoveryPrincipal} from '../src/memory/authority-recovery.js';
import {MemoryRecoveryService} from '../src/memory/recovery.js';
import {managedRecoveryStore} from '../src/memory/managed-recovery.js';
import {MainnetExactStorage} from '../src/memory/exact.js';
import {resolveAccountOwner} from '../src/memory/account-owner.js';
import {MemwalRecordAdapter} from '../src/memory/memwal-adapter.js';
import {canonicalSerialize,contentHash,serializeMemoryRecord} from '../src/domain/serialization.js';
import type {MemoryRecordV2,MemoryReceipt} from '../src/domain/contracts.js';
import {operationNamespace} from '../src/memory/operations.js';
import {GameplayService} from '../src/gameplay/service.js';

const args=new Set(process.argv.slice(2));
const checkpointPath='reports/authority-mainnet-checkpoint.json',reportPath='reports/authority-mainnet.json';
type Checkpoint={version:1;fixture:true;noDelete:true;id:string;createdAt:string;phase:string;sourceSchema:string;targetSchema:string;sourceUser:string;targetUser:string;runId:string;bindingId:string;identityHash:string;sourceSession:string;targetSession:string;initialized?:boolean;record?:MemoryRecordV2;receipt?:MemoryReceipt;jobs:Record<string,{namespace:string;bytesHash:string;jobId?:string;result?:{id:string;blob_id:string;owner:string;namespace:string}}> ;published?:boolean;restored?:boolean};
let phase='guards';
async function main(){
 if(!args.has('--synthetic-fixture')||!args.has('--no-delete')||!args.has('--allow-mainnet-write')||!args.has('--allow-production-pg-fixture-schemas'))throw Error('EXPLICIT_FIXTURE_FLAGS_REQUIRED');
 const c=config();if(c.MEMORY_MODE!=='mainnet'||!c.DATABASE_URL||!c.MEMWAL_PRIVATE_KEY||!c.MEMWAL_ACCOUNT_ID)throw Error('MAINNET_PG_CONFIGURATION_REQUIRED');
 await mkdir('reports',{recursive:true});
 let state:Checkpoint;
 if(args.has('--resume'))state=JSON.parse(await readFile(checkpointPath,'utf8'));
 else{
  try{await readFile(checkpointPath);throw Error('CHECKPOINT_EXISTS_USE_RESUME');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const id=randomUUID().replaceAll('-','');state={version:1,fixture:true,noDelete:true,id,createdAt:new Date().toISOString(),phase,sourceSchema:`dfm_authority_proof_src_${id}`,targetSchema:`dfm_authority_proof_dst_${id}`,sourceUser:`verification-authority-${id}`,targetUser:`verification-authority-fresh-${id}`,runId:randomUUID(),bindingId:`verification-authority-binding-${id}`,identityHash:createHash('sha256').update(JSON.stringify(['synthetic-authority-proof',id])).digest('hex'),sourceSession:randomUUID(),targetSession:randomUUID(),jobs:{}};
 }
 if(state.version!==1||state.fixture!==true||state.noDelete!==true||!/^[a-f0-9]{32}$/.test(state.id)||state.sourceSchema!==`dfm_authority_proof_src_${state.id}`||state.targetSchema!==`dfm_authority_proof_dst_${state.id}`||state.sourceUser!==`verification-authority-${state.id}`||state.targetUser!==`verification-authority-fresh-${state.id}`)throw Error('INVALID_FIXTURE_CHECKPOINT');
 const save=async()=>{state.phase=phase;await writeFile(checkpointPath+'.tmp',JSON.stringify(state,null,2));await rename(checkpointPath+'.tmp',checkpointPath);};await save();
 const admin=new pg.Pool({connectionString:c.DATABASE_URL,max:1});
 const makePool=(schema:string)=>{const url=new URL(c.DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);return new pg.Pool({connectionString:url.toString(),max:2});};
 const source=makePool(state.sourceSchema),target=makePool(state.targetSchema),sourceRepo=new PostgresRepository(source),targetRepo=new PostgresRepository(target);
 const sdk=MemWal.create({key:c.MEMWAL_PRIVATE_KEY,accountId:c.MEMWAL_ACCOUNT_ID,serverUrl:c.MEMWAL_SERVER_URL});
 try{
  phase='isolated_schema_setup';
  for(const schema of [state.sourceSchema,state.targetSchema]){await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);}
  for(const [pool,repo]of [[source,sourceRepo],[target,targetRepo]] as const){
   await repo.migrate();for(const file of ['002_memory_operations.sql','003_case_shares.sql','005_personal_accounts.sql','006_ownership_migration.sql'])await pool.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
   await pool.query('CREATE TABLE IF NOT EXISTS dfm_state(id integer PRIMARY KEY CHECK(id=1),body jsonb NOT NULL)');
  }
  const owner=await resolveAccountOwner(c.MEMWAL_ACCOUNT_ID,c.MEMWAL_SERVER_URL),scope={userId:state.sourceUser,runId:state.runId,revision:1,accountBindingId:state.bindingId,accountObjectId:c.MEMWAL_ACCOUNT_ID,owner,network:'mainnet' as const};
  const principal=(userId:string,sessionId:string):RecoveryPrincipal=>({userId,sessionId,identityHash:state.identityHash});
  const installIdentity=async(pool:pg.Pool,userId:string,sessionId:string)=>{
   await pool.query("INSERT INTO users(id,issuer,subject,display_name) VALUES($1,'synthetic-fixture',$1,'Synthetic authority proof') ON CONFLICT(id) DO NOTHING",[userId]);
   const body={users:{[userId]:{id:userId,name:'Synthetic authority proof'}},runs:{},localMemories:{},authV2:{identities:{[state.identityHash]:userId},sessions:{[sessionId]:{id:sessionId,userId,accessExpiresAt:Date.now()+86400000,rotated:false,revoked:false}}}};
   await pool.query('INSERT INTO dfm_state VALUES(1,$1) ON CONFLICT(id) DO NOTHING',[body]);
  };
  const expectedState={physicalObjects:{instances:[{instanceId:`fixture-item-${state.id}`,itemId:'coffee',quantity:1,status:'carried'}],heldInstanceId:`fixture-item-${state.id}`},verificationFixture:true};
  if(!state.initialized){
   await installIdentity(source,state.sourceUser,state.sourceSession);await installIdentity(target,state.targetUser,state.targetSession);
   await source.query("INSERT INTO account_bindings(id,user_id,network,mode,account_id,status,payload) VALUES($1,$2,'mainnet','sponsored',$3,'active','{}') ON CONFLICT(id) DO NOTHING",[state.bindingId,state.sourceUser,c.MEMWAL_ACCOUNT_ID]);
   await source.query("INSERT INTO runs(id,user_id,story_version,revision,event_sequence,checkpoint,state,status) VALUES($1,$2,'full-memory-v2',1,1,$3,$4,'active') ON CONFLICT(id) DO NOTHING",[state.runId,state.sourceUser,{beatId:'synthetic-authority',day:2,sceneId:'synthetic-scene',stepIndex:1,scheduleIndex:2,phase:'dialogue'},expectedState]);
   const eventId=`fixture-event-${state.id}`;
   await source.query("INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,1,'synthetic_fixture',$4,$5) ON CONFLICT DO NOTHING",[state.runId,eventId,state.sourceUser,{synthetic:true},contentHash('synthetic-fixture')]);
   state.record={schemaVersion:2,id:`fixture-memory-${state.id}`,eventId,userId:state.sourceUser,runId:state.runId,sessionId:'synthetic-fixture',sequence:1,storyVersion:'full-memory-v2',beatId:'synthetic-authority',inGameDay:1,createdAt:state.createdAt,actor:'player',kind:'hypothesis',text:`Synthetic checkpoint authority proof ${state.id}. No real player evidence.`,epistemicStatus:'hypothesized',sourceIds:[],originIds:[`fixture-memory-${state.id}`],recipients:['player'],entityIds:[],propositionIds:[]};
   const serial=serializeMemoryRecord(state.record);
   await source.query('INSERT INTO memory_records(id,run_id,user_id,event_id,sequence,kind,payload,payload_bytes,content_hash,representation_key) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[state.record.id,state.runId,state.sourceUser,eventId,state.record.kind,state.record,serial.bytes,serial.contentHash,`v2:${state.record.id}:${serial.contentHash}`]);
   await source.query("INSERT INTO transactions(id,user_id,run_id,order_id,item_id,quantity,price_table_version,unit_price,paid_amount,accepted_change,state,payload) VALUES($1,$2,$3,'synthetic-order','coffee',1,'synthetic-price-v1',20000,50000,30000,'settled','{}') ON CONFLICT DO NOTHING",[`fixture-commerce-${state.id}`,state.sourceUser,state.runId]);
   state.initialized=true;await save();
  }
  // Persist each accepted job before polling. All namespaces, keys and job IDs stay scoped to this synthetic run.
  const resumableRemember=async(bytes:string,namespace:string,options:{idempotencyKey:string;timeoutMs:number})=>{
   const hash=contentHash(bytes),key=contentHash(namespace+'\n'+options.idempotencyKey),job=state.jobs[key]??={namespace,bytesHash:hash};
   if(job.namespace!==namespace||job.bytesHash!==hash)throw Error('JOB_CHECKPOINT_SCOPE_MISMATCH');
   if(job.result)return job.result;
   if(!job.jobId){const accepted=await sdk.remember(bytes,namespace,{idempotencyKey:options.idempotencyKey});job.jobId=accepted.job_id;await save();}
   const result=await sdk.waitForRememberJob(job.jobId,{timeoutMs:120000});
   if(result.owner!==owner||result.namespace!==namespace||!result.blob_id)throw Error('JOB_RESULT_SCOPE_MISMATCH');job.result=result;await save();return result;
  };
  const managedSdk={recall:(input:{query:string;namespace:string;limit:number})=>sdk.recall(input),rememberAndWait:resumableRemember};
  const storage=new MainnetExactStorage({relayerUrl:c.MEMWAL_SERVER_URL});
  const recovery=()=>new MemoryRecoveryService(managedRecoveryStore(async()=>managedSdk,async(_s,ns)=>storage.list(ns,{key:c.MEMWAL_PRIVATE_KEY!,accountId:c.MEMWAL_ACCOUNT_ID!})));
  if(!state.published){
   phase='mainnet_record_write';const adapter=new MemwalRecordAdapter(sdk),record=state.record!;
   const indexed=await adapter.write(record,{accountBindingId:state.bindingId,namespace:operationNamespace(scope),network:'mainnet'},state.receipt,async receipt=>{state.receipt=receipt;await save();});
   state.receipt=await adapter.verifyRecall(record,indexed,record.text);await save();
   const receipt=state.receipt,serial=serializeMemoryRecord(record);
   await source.query("INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,'retrievable',$4,$5) ON CONFLICT(record_id,account_binding_id,namespace) DO UPDATE SET receipt=$5,state='retrievable'",[record.id,state.bindingId,receipt.namespace,receipt.contentHash,receipt]);
   await source.query("INSERT INTO outbox_jobs(id,user_id,run_id,record_id,event_id,account_binding_id,namespace,representation_key,payload_bytes,content_hash,state,accepted_job_id,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'retrievable',$11,$12) ON CONFLICT DO NOTHING",[`fixture-outbox-${state.id}`,state.sourceUser,state.runId,record.id,record.eventId,state.bindingId,receipt.namespace,`v2:${record.id}:${serial.contentHash}`,serial.bytes,serial.contentHash,receipt.jobId,receipt]);
   phase='signed_authority_publish';
   await new AuthorityRecoveryService(sourceRepo,recovery(),c.SESSION_SECRET,()=>new Date(state.createdAt)).publish(scope,principal(state.sourceUser,state.sourceSession));state.published=true;await save();
  }
  phase='fresh_remote_authority_restore';
  if(!state.restored){
   const existing=(await target.query('SELECT count(*)::int n FROM runs')).rows[0].n;
   if(existing!==0)throw Error('TARGET_NOT_EMPTY_MANUAL_RESUME_REVIEW_REQUIRED');
   const result=await new AuthorityRecoveryService(targetRepo,recovery(),c.SESSION_SECRET).restore(scope,principal(state.targetUser,state.targetSession));
   if(!result.playable||result.revision!==1)throw Error('AUTHORITY_RESTORE_NOT_PLAYABLE');state.restored=true;await save();
  }
  phase='verify_restored_authority';const run=await targetRepo.getRun(state.sourceUser,state.runId);
  if(canonicalSerialize(run.state)!==canonicalSerialize(expectedState)||run.checkpoint.day!==2||run.checkpoint.stepIndex!==1)throw Error('RESTORED_CHECKPOINT_STATE_MISMATCH');
  const commerce=(await target.query('SELECT paid_amount,accepted_change,state FROM transactions WHERE run_id=$1',[state.runId])).rows[0];if(commerce?.paid_amount!==50000||commerce.accepted_change!==30000||commerce.state!=='settled')throw Error('RESTORED_COMMERCE_MISMATCH');
  const auth=(await target.query('SELECT body FROM dfm_state WHERE id=1')).rows[0].body;if(auth.authV2.sessions[state.targetSession].userId!==state.sourceUser||auth.authV2.identities[state.identityHash]!==state.sourceUser)throw Error('RESTORED_AUTH_MAPPING_MISMATCH');
  const sourceBytes=(await target.query('SELECT payload_bytes FROM memory_records WHERE id=$1',[state.record!.id])).rows[0]?.payload_bytes;if(sourceBytes!==serializeMemoryRecord(state.record!).bytes)throw Error('RESTORED_SOURCE_BYTES_MISMATCH');
  const ledger=(await target.query('SELECT event_id,sequence,kind,payload,request_hash FROM domain_events WHERE run_id=$1 AND sequence=1 ORDER BY sequence',[state.runId])).rows;
  const originalLedger=(await source.query('SELECT event_id,sequence,kind,payload,request_hash FROM domain_events WHERE run_id=$1 ORDER BY sequence',[state.runId])).rows;
  if(ledger.length!==1||canonicalSerialize(ledger)!==canonicalSerialize(originalLedger))throw Error('RESTORED_LEDGER_MISMATCH');
  const restoredReceipt=(await target.query('SELECT receipt FROM memory_receipts WHERE record_id=$1 AND account_binding_id=$2',[state.record!.id,state.bindingId])).rows[0]?.receipt;
  const restoredOutbox=(await target.query('SELECT state,receipt,lease_token FROM outbox_jobs WHERE run_id=$1 AND record_id=$2',[state.runId,state.record!.id])).rows;
  if(canonicalSerialize(restoredReceipt)!==canonicalSerialize(state.receipt)||restoredOutbox.length!==1||restoredOutbox[0].state!=='retrievable'||restoredOutbox[0].lease_token!==null||canonicalSerialize(restoredOutbox[0].receipt)!==canonicalSerialize(state.receipt))throw Error('RESTORED_RECEIPT_OUTBOX_MISMATCH');
  phase='commit_synthetic_gameplay_continuation';
  const gameplay=new GameplayService(targetRepo,async()=>({id:state.bindingId,namespace:operationNamespace(scope),network:'mainnet'}));
  const continuationActionId=`authority-proof-continuation-${state.id}`;
  const prior=(await target.query('SELECT payload FROM domain_events WHERE run_id=$1 AND client_action_id=$2',[state.runId,continuationActionId])).rows[0];
  if(!prior){
   if(run.revision!==1)throw Error('UNEXPECTED_FIXTURE_REVISION');
   const action={kind:'note' as const,text:'Synthetic continuation committed after remote restore',recordIds:[state.record!.id]};
   const preview=await gameplay.preview(state.sourceUser,state.runId,action);
   await gameplay.commit(state.sourceUser,state.targetSession,state.runId,{expectedRevision:preview.revision,clientActionId:continuationActionId,consentHash:preview.consentHash,action});
  }
  const committed=(await target.query('SELECT sequence,payload FROM domain_events WHERE run_id=$1 AND client_action_id=$2',[state.runId,continuationActionId])).rows;
  const continuationRecord=committed[0]?.payload?.result?.record;
  if(committed.length!==1||committed[0].sequence!==2||!continuationRecord||continuationRecord.sourceIds?.[0]!==state.record!.id||continuationRecord.userId!==state.sourceUser)throw Error('CONTINUATION_COMMIT_MISMATCH');
  const continuationJobs=(await target.query('SELECT state,content_hash FROM outbox_jobs WHERE run_id=$1 AND record_id=$2',[state.runId,continuationRecord.id])).rows;
  if(continuationJobs.length!==1||continuationJobs[0].state!=='queued'||continuationJobs[0].content_hash!==serializeMemoryRecord(continuationRecord).contentHash)throw Error('CONTINUATION_OUTBOX_MISMATCH');
  const after=await targetRepo.getRun(state.sourceUser,state.runId);if(after.revision!==2||after.eventSequence!==2)throw Error('CONTINUATION_REVISION_MISMATCH');
  const head=await recovery().discover(scope),report={verifiedAt:new Date().toISOString(),fixture:true,countsAsPlayerUsage:false,network:'mainnet',sourceSchema:state.sourceSchema,targetSchema:state.targetSchema,emptyTargetSchemaBeforeRestore:true,wholeDatabaseDisaster:false,productionPlayerRowsModified:false,deletionsPerformed:false,syntheticIdentity:true,realGoogleSignInProof:false,checkpointRestored:true,stateInventoryRestored:true,commerceRestored:true,ledgerRestored:true,receiptsRestored:true,authenticatedFixtureSessionRemapped:true,gameplayContinuationPreview:true,gameplayCommitAfterRestore:false,directoryBlobId:head.anchor.blobId,authorityBlobId:head.directory.authority?.blobId,recordBlobId:state.receipt?.blobId,provenance:'verified_reference_manifest_replay',independentSealRead:false,schemasRetained:true};
  Object.assign(report,{gameplayCommitAfterRestore:true,gameplayContinuationRecordId:continuationRecord.id,gameplayContinuationRevision:after.revision,gameplayContinuationOutboxState:'queued',gameplayContinuationUploaded:false});
  await writeFile(reportPath,JSON.stringify(report,null,2));phase='complete';await save();console.log(JSON.stringify(report,null,2));
 }finally{sdk.destroy();await Promise.all([source.end(),target.end(),admin.end()]);}
}
main().catch(error=>{console.error('AUTHORITY_MAINNET_PROOF_FAILED',JSON.stringify({phase,code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'UPSTREAM_UNAVAILABLE',resume:'Re-run same command with --resume; schema fixtures are retained.'}));process.exitCode=1;});

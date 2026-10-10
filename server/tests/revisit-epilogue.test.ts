import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresRepository} from '../src/persistence/repository.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
import {beats,STORY_VERSION} from '../src/story/canon.js';
import {RevisitService,authorizedRevisitBeat,finishRevisit} from '../src/story/revisit.js';
import {LifecycleService} from '../src/memory/lifecycle.js';
import {EpilogueService,generateEpilogue} from '../src/dialogue/epilogue.js';
import {serializeMemoryRecord} from '../src/domain/serialization.js';
import type {MemoryRecordV2} from '../src/domain/contracts.js';
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';assertTestDatabase(database);
const ns='revisit_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database}),pool=new pg.Pool({connectionString:database,options:`-c search_path=${ns},public`}),repo=new PostgresRepository(pool);
beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${ns}`);await repo.migrate();});
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${ns} CASCADE`);await admin.end();});
async function fixture(){
 const userId=await repo.upsertUser('fixture',randomUUID()),beat=beats.find(b=>b.kind==='greeting')!;
 const run=await repo.createRun({userId,storyVersion:STORY_VERSION,initialCheckpoint:{beatId:'complete',day:6,sceneId:'complete',stepIndex:0,scheduleIndex:999,phase:'complete'}});
 const id=randomUUID(),eventId=randomUUID();
 const record:MemoryRecordV2={schemaVersion:2,id,eventId,userId,runId:run.id,sessionId:'fixture',sequence:1,storyVersion:STORY_VERSION,beatId:beat.beatId,inGameDay:beat.day,createdAt:new Date().toISOString(),actor:beat.npcId as MemoryRecordV2['actor'],kind:'utterance',epistemicStatus:'said',text:'The source records an attributed greeting.',sourceIds:[],originIds:[id],recipients:['player','phuc'],entityIds:[],propositionIds:[]};
 await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,1,$4,$5,$6)',[run.id,eventId,userId,'fixture',{},'fixture']);
 const c=await pool.connect(),serialized=serializeMemoryRecord(record);try{await repo.insertRecord(c,record,serialized.bytes,serialized.contentHash);}finally{c.release();}
 const binding={id:'fixture:'+userId,namespace:'fixture:'+run.id,network:'local' as const};
 await pool.query('INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,$3,$4,$5)',[binding.id,userId,'local','local','fixture-account']);
 await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',[id,binding.id,binding.namespace,'retrievable',serialized.contentHash,{recordId:id,accountBindingId:binding.id,namespace:binding.namespace,network:'local',state:'retrievable',blobId:'fixture:'+id,contentHash:serialized.contentHash,verifiedAt:new Date().toISOString(),lastRecallAt:new Date().toISOString()}]);
 await pool.query('UPDATE runs SET state=$2,event_sequence=1 WHERE id=$1',[run.id,{outcome:'unresolved',caseReview:{outcome:'unresolved',sourceIds:[id],missing:['Independent corroboration']}}]);
 return {run,beat,record,binding,serialized};
}
it('revisits only seen authored speech by CAS, persists selection across resume and restores prior cursor',async()=>{
 const f=await fixture(),service=new RevisitService(repo),options=await service.options(f.run.userId,f.run.id);expect(options.map(o=>o.beatId)).toEqual([f.beat.beatId]);
 const input={userId:f.run.userId,runId:f.run.id,expectedRevision:0,clientActionId:randomUUID(),beatId:f.beat.beatId};
 const selected=await service.select(input);expect(selected.run.revision).toBe(1);expect(authorizedRevisitBeat(await repo.getRun(f.run.userId,f.run.id))?.beatId).toBe(f.beat.beatId);
 expect((await service.select(input)).replayed).toBe(true);
 const resumed=await repo.getRun(f.run.userId,f.run.id);expect(finishRevisit(resumed)).toBe(true);expect(resumed.checkpoint).toEqual(f.run.checkpoint);expect(resumed.state.revisit).toBeUndefined();
 await expect(service.select({...input,clientActionId:randomUUID(),expectedRevision:0})).rejects.toThrow('REVISION_CONFLICT');
});
it('rejects foreign owners, unvisited/future witnesses and pre-day6 revisit',async()=>{
 const f=await fixture(),service=new RevisitService(repo);
 await expect(service.options(randomUUID(),f.run.id)).rejects.toThrow('FORBIDDEN');
 await expect(service.select({userId:f.run.userId,runId:f.run.id,expectedRevision:0,clientActionId:randomUUID(),beatId:beats.find(b=>b.day===6)!.beatId})).rejects.toThrow('BEAT_NOT_AVAILABLE');
 await pool.query("UPDATE runs SET checkpoint=jsonb_set(checkpoint,'{day}','5') WHERE id=$1",[f.run.id]);await expect(service.options(f.run.userId,f.run.id)).rejects.toThrow('REVISIT_NOT_OPEN');
});
it('generates verified source epilogue once, caches across action IDs and commits one immutable speech',async()=>{
 const f=await fixture();let calls=0;
 const service=new EpilogueService(repo,{binding:async()=>f.binding,memoryBackend:{semantic:async()=>[],exact:async blobId=>({blobId,bytes:f.serialized.bytes})},provider:{modelId:'fixture',complete:async()=>{calls++;return {utterance:'The case remains unresolved; this greeting is attributed testimony.',sourceIds:[f.record.id]};}},semanticChecker:async(_result,context)=>({supported:context.outcome==='unresolved'})});
 const input={userId:f.run.userId,runId:f.run.id,sessionId:'fixture',expectedRevision:0,clientActionId:randomUUID()};
 expect((await service.request(input)).result).toMatchObject({outcome:'unresolved',generation:'llm'});
 expect((await service.request({...input,clientActionId:randomUUID()})).replayed).toBe(true);expect(calls).toBe(1);
 expect((await pool.query("SELECT count(*)::int n FROM memory_records WHERE run_id=$1 AND payload->>'actor'='phuc'",[f.run.id])).rows[0].n).toBe(1);
 expect((await repo.getRun(f.run.userId,f.run.id)).state.outcome).toBe('unresolved');
});
it('requires exact retrieval and semantic checking; rejects model-selected outcomes and invented citations',async()=>{
 const f=await fixture();const input={userId:f.run.userId,runId:f.run.id,sessionId:'fixture',expectedRevision:0,clientActionId:randomUUID()};
 const options={binding:async()=>f.binding,memoryBackend:{semantic:async()=>[]},provider:{modelId:'fixture',complete:async()=>({utterance:'Evidence',sourceIds:[f.record.id]})},semanticChecker:async()=>({supported:true})};
 await expect(new EpilogueService(repo,options).request(input)).rejects.toThrow('EXACT_SOURCE_UNAVAILABLE');
 const context={actor:'phuc' as const,outcome:'unresolved' as const,missing:[],sources:[],causes:[]};
 await expect(generateEpilogue({modelId:'fixture',complete:async()=>({utterance:'Solved',sourceIds:['invented'],outcome:'resolved'})},async()=>({supported:true}),context)).rejects.toThrow('GENERATION_UNAVAILABLE');
 expect((await repo.getRun(f.run.userId,f.run.id)).revision).toBe(0);
});


it('supports real fresh semantic-only verified reads and preserves their retrieval provenance',async()=>{
 const f=await fixture();let provenance='';
 const service=new EpilogueService(repo,{binding:async()=>f.binding,memoryBackend:{semantic:async()=>[{blobId:'fixture:'+f.record.id,bytes:f.serialized.bytes}]},provider:{modelId:'fixture',complete:async()=>({utterance:'The case remains unresolved, according to the reported evidence.',sourceIds:[f.record.id]})},semanticChecker:async(_turn,context)=>{provenance=context.sources[0].retrieval;return {supported:true};}});
 const result=await service.request({userId:f.run.userId,runId:f.run.id,sessionId:'fixture',expectedRevision:0,clientActionId:randomUUID()});expect(result.result).toMatchObject({outcome:'unresolved'});expect(provenance).toBe('semantic');
});
it('keeps a rejected session from committing generated epilogue and arbitrates simultaneous devices by CAS',async()=>{
 const f=await fixture();
 const service=new EpilogueService(repo,{binding:async()=>f.binding,memoryBackend:{semantic:async()=>[{blobId:'fixture:'+f.record.id,bytes:f.serialized.bytes}]},provider:{modelId:'fixture',complete:async()=>({utterance:'The reported case is unresolved.',sourceIds:[f.record.id]})},semanticChecker:async()=>({supported:true})});
 const input={userId:f.run.userId,runId:f.run.id,sessionId:'fixture',expectedRevision:0,clientActionId:randomUUID()};
 await expect(service.request(input,async()=>{throw new Error('SESSION_REVOKED');})).rejects.toThrow('SESSION_REVOKED');expect((await repo.getRun(f.run.userId,f.run.id)).revision).toBe(0);
 const raced=await Promise.allSettled([service.request({...input,clientActionId:randomUUID()}),service.request({...input,clientActionId:randomUUID()})]);const fulfilled=raced.filter(r=>r.status==='fulfilled');expect(fulfilled.length).toBeGreaterThanOrEqual(1);expect(fulfilled.filter(r=>r.status==='fulfilled'&&!r.value.replayed)).toHaveLength(1);for(const result of raced)if(result.status==='rejected')expect(String(result.reason)).toContain('REVISION_CONFLICT');
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE run_id=$1 AND kind='epilogue_generated'",[f.run.id])).rows[0].n).toBe(1);
});
it('reloads cached state after authorization waits and denies lifecycle-deleted cached speech',async()=>{
 const f=await fixture(),lifecycle=new LifecycleService(repo);await lifecycle.migrate();
 const service=new EpilogueService(repo,{binding:async()=>f.binding,memoryBackend:{semantic:async()=>[{blobId:'fixture:'+f.record.id,bytes:f.serialized.bytes}]},provider:{modelId:'fixture',complete:async()=>({utterance:'The recorded investigation remains unresolved.',sourceIds:[f.record.id]})},semanticChecker:async()=>({supported:true})});
 const input={userId:f.run.userId,runId:f.run.id,sessionId:'fixture',expectedRevision:0,clientActionId:randomUUID()};
 await service.request(input);
 const preview=await lifecycle.preview(f.run.userId,f.run.id,{kind:'delete',recordIds:[f.record.id]});
 await expect(service.request({...input,clientActionId:randomUUID()},async work=>{
  await lifecycle.confirm(f.run.userId,f.run.id,preview.operationId,{confirmed:true,confirmationHash:preview.confirmationHash});
  return work();
 })).rejects.toThrow('EPILOGUE_NOT_AVAILABLE');
 const current=await repo.getRun(f.run.userId,f.run.id);expect(current.revision).toBe(2);expect(current.state.outcome).toBe('pending');expect(current.state.epilogue).toBeUndefined();
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE run_id=$1 AND kind='epilogue_generated'",[f.run.id])).rows[0].n).toBe(1);
});

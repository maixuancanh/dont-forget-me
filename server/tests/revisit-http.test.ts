import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../src/app.js';
import {schema} from '../src/config.js';
import {PostgresRepository} from '../src/persistence/repository.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
import {beats,STORY_VERSION} from '../src/story/canon.js';
import {progressionBeats} from '../src/runs/service.js';
import {serializeMemoryRecord} from '../src/domain/serialization.js';
import type {MemoryRecordV2} from '../src/domain/contracts.js';
import type {DialogueProvider} from '../src/dialogue/provider.js';
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';assertTestDatabase(database);
const ns='revisit_http_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database}),pool=new pg.Pool({connectionString:database,options:`-c search_path=${ns},public`}),repo=new PostgresRepository(pool);
let app:FastifyInstance,directory:string,headers:Record<string,string>,foreign:Record<string,string>,providerCalls=0,checkerCalls=0,omitMemory=false,checkerApprove=true;
const provider:DialogueProvider={modelId:'fixture-revisit-http',complete:async messages=>{
 providerCalls++;
 const packet=JSON.parse(messages[1].content);
 if(messages[0].content.startsWith('Assess all claims')){checkerCalls++;return {supported:checkerApprove};}
 if(messages[0].content.includes('case epilogue'))return {utterance:'The server records an unresolved case; the reported source remains attributed testimony.',sourceIds:[packet.sources[0].id]};
 const proposition=packet.authorizedPropositions[0];
 return {utterance:proposition.meaning,sourceIds:[],expressedPropositionIds:[proposition.id],intent:'answer',actions:[]};
}};
beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'dfm-revisit-http-'));await admin.query(`CREATE SCHEMA ${ns}`);await repo.migrate();
 app=(await createApp(schema.parse({SESSION_SECRET:'fixture-revisit-http-secret-only-32',DATA_FILE:join(directory,'auth.json')}),undefined,undefined,undefined,{repository:repo,provider,startWorker:false,semanticChecker:async()=>({supported:true}),memoryBackend:{semantic:async(_query,namespace)=>omitMemory?[]:(await pool.query('SELECT m.payload_bytes,r.receipt FROM memory_records m JOIN memory_receipts r ON r.record_id=m.id WHERE r.namespace=$1',[namespace])).rows.map(r=>({blobId:r.receipt.blobId,bytes:r.payload_bytes}))}})).app;
 const login=async(name:string)=>{const response=await app.inject({method:'POST',url:'/v1/session',payload:{name,accessCode:`fixture-${name}-access-code`}});expect(response.statusCode).toBe(200);return {authorization:`Bearer ${response.json().token??response.json().accessToken}`};};
 headers=await login('alice');foreign=await login('bob');
});
afterAll(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${ns} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});});
async function fixture(){
 const created=await app.inject({method:'POST',url:'/v2/runs',headers,payload:{}});expect(created.statusCode).toBe(200);const run=created.json().run;
 const beat=beats.find(b=>b.kind==='greeting'&&b.propositionIds.length)!;
 const checkpoint={beatId:'complete',day:6,sceneId:'complete',stepIndex:0,scheduleIndex:progressionBeats.length,phase:'complete'};
 const id=randomUUID(),eventId=randomUUID(),record:MemoryRecordV2={schemaVersion:2,id,eventId,userId:run.userId,runId:run.id,sessionId:'fixture',sequence:1,storyVersion:STORY_VERSION,beatId:beat.beatId,inGameDay:beat.day,createdAt:new Date().toISOString(),actor:beat.npcId as MemoryRecordV2['actor'],kind:'utterance',epistemicStatus:'said',text:'A fixture attributed statement reported to Phuc.',sourceIds:[],originIds:[id],recipients:['player','phuc'],entityIds:[],propositionIds:[]};
 await pool.query('UPDATE runs SET checkpoint=$2,state=$3,event_sequence=1 WHERE id=$1',[run.id,checkpoint,{outcome:'unresolved',caseReview:{outcome:'unresolved',sourceIds:[id],missing:['Independent corroboration']}}]);
 await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,1,$4,$5,$6)',[run.id,eventId,run.userId,'fixture',{},'fixture']);
 const c=await pool.connect(),serialized=serializeMemoryRecord(record);try{await repo.insertRecord(c,record,serialized.bytes,serialized.contentHash);}finally{c.release();}
 const bindingId=`runtime:local:${run.userId}`,namespace=`dfm:v2:${run.userId}:${run.id}:case`;
 await pool.query("INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,'local','local','local-fixture-account') ON CONFLICT(id) DO NOTHING",[bindingId,run.userId]);
 await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',[id,bindingId,namespace,'retrievable',serialized.contentHash,{recordId:id,accountBindingId:bindingId,namespace,network:'local',state:'retrievable',blobId:'fixture:'+id,contentHash:serialized.contentHash,verifiedAt:new Date().toISOString(),lastRecallAt:new Date().toISOString()}]);
 return {run,beat,record,checkpoint};
}
it('selects seen authored revisit, generates a real authorized player-question turn and ACK restores original cursor',async()=>{
 const f=await fixture(),url=`/v2/runs/${f.run.id}`;
 const choices=await app.inject({url:url+'/revisits',headers});expect(choices.statusCode).toBe(200);expect(choices.json().options.map((o:any)=>o.beatId)).toEqual([f.beat.beatId]);
 const selection={beatId:f.beat.beatId,expectedRevision:0,clientActionId:randomUUID()};
 const selected=await app.inject({method:'POST',url:url+'/revisits',headers,payload:selection});expect(selected.statusCode).toBe(200);expect(selected.json()).toMatchObject({runRevision:1,nextEvent:{npcId:f.beat.npcId,beatId:f.beat.beatId,day:6}});
 expect((await app.inject({url,headers})).json().nextEvent.beatId).toBe(f.beat.beatId);
 const question={clientTurnId:randomUUID(),expectedRevision:1,npcId:f.beat.npcId,beatId:f.beat.beatId,trigger:'player_question',message:'Please revisit your earlier account.',presentedRecordIds:[]};
 const generated=await app.inject({method:'POST',url:url+'/turns',headers,payload:question});expect(generated.statusCode).toBe(200);expect(generated.json().generation).toBe('llm');
 const blocked=await app.inject({method:'POST',url:url+'/revisits',headers,payload:{...selection,expectedRevision:2,clientActionId:randomUUID()}});expect(blocked.statusCode).toBe(409);
 const ack=await app.inject({method:'POST',url:url+'/turns/'+generated.json().turnId+'/ack',headers,payload:{expectedRevision:2,clientActionId:randomUUID()}});expect(ack.statusCode).toBe(200);expect(ack.json()).toMatchObject({acknowledged:true,runRevision:3,nextEvent:{kind:'complete'}});
 const resumed=await repo.getRun(f.run.userId,f.run.id);expect(resumed.checkpoint).toEqual(f.checkpoint);expect(resumed.state.revisit).toBeUndefined();expect(resumed.state.outcome).toBe('unresolved');
 expect((await pool.query("SELECT count(*)::int n FROM turns WHERE run_id=$1 AND status='committed'",[f.run.id])).rows[0].n).toBe(0);
});
it('rejects foreign owners, future unvisited beats and pending speech before selection',async()=>{
 const f=await fixture(),url=`/v2/runs/${f.run.id}`;
 expect((await app.inject({url:url+'/revisits',headers:foreign})).statusCode).toBe(403);
 const unavailable=await app.inject({method:'POST',url:url+'/revisits',headers,payload:{beatId:beats.find(b=>b.day===6)!.beatId,expectedRevision:0,clientActionId:randomUUID()}});expect(unavailable.statusCode).toBe(409);expect(unavailable.json().error).toBe('BEAT_NOT_AVAILABLE');
 await repo.commitTurn({userId:f.run.userId,runId:f.run.id,expectedRevision:0,clientTurnId:randomUUID(),turnId:randomUUID(),eventId:randomUUID(),response:{fixture:true},records:[]});
 const pending=await app.inject({method:'POST',url:url+'/revisits',headers,payload:{beatId:f.beat.beatId,expectedRevision:1,clientActionId:randomUUID()}});expect(pending.statusCode).toBe(409);expect(pending.json().error).toBe('TURN_ACK_REQUIRED');
});
it('HTTP epilogue uses verified semantic memory and strict default provider checker, then caches by case outcome',async()=>{
 const f=await fixture(),url=`/v2/runs/${f.run.id}/epilogue`,before=providerCalls,beforeCheck=checkerCalls;
 const payload={expectedRevision:0,clientActionId:randomUUID()},first=await app.inject({method:'POST',url,headers,payload});expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({outcome:'unresolved',generation:'llm',runRevision:1,citations:[{recordId:f.record.id}]});expect(checkerCalls).toBe(beforeCheck+1);expect(providerCalls).toBe(before+2);
 const replay=await app.inject({method:'POST',url,headers,payload:{...payload,clientActionId:randomUUID()}});expect(replay.statusCode).toBe(200);expect(replay.json().replayed).toBe(true);expect(providerCalls).toBe(before+2);
 expect((await repo.getRun(f.run.userId,f.run.id)).state.outcome).toBe('unresolved');expect((await app.inject({method:'POST',url,headers:foreign,payload})).statusCode).toBe(403);
});
it('missing remote sources and checker rejection stay operational without committing or changing ending',async()=>{
 const f=await fixture(),url=`/v2/runs/${f.run.id}/epilogue`,payload={expectedRevision:0,clientActionId:randomUUID()};
 omitMemory=true;const unavailable=await app.inject({method:'POST',url,headers,payload});omitMemory=false;expect(unavailable.statusCode).toBe(503);
 checkerApprove=false;const rejected=await app.inject({method:'POST',url,headers,payload});checkerApprove=true;expect(rejected.statusCode).toBe(503);
 expect((await repo.getRun(f.run.userId,f.run.id)).revision).toBe(0);expect((await repo.getRun(f.run.userId,f.run.id)).state.outcome).toBe('unresolved');
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE run_id=$1 AND kind='epilogue_generated'",[f.run.id])).rows[0].n).toBe(0);
});
it('actual disclosure authorizes original immutable Duy source for Phuc while Hanh remains denied',async()=>{
 const f=await fixture(),url=`/v2/runs/${f.run.id}`,bindingId=`runtime:local:${f.run.userId}`,namespace=`dfm:v2:${f.run.userId}:${f.run.id}:case`;
 const seen:Record<string,{beat:typeof beats[number];record:MemoryRecordV2}>={};
 for(const [index,npc] of ['duy','phuc','hanh'].entries()){
  const beat=beats.find(b=>b.npcId===npc&&['greeting','conversation'].includes(b.kind)&&b.propositionIds.length&&!b.revealConditions.serverPrivate)!,id=randomUUID(),eventId=randomUUID(),sequence=index+2;
  const record:MemoryRecordV2={...f.record,id,eventId,sequence,beatId:beat.beatId,inGameDay:beat.day,actor:npc as MemoryRecordV2['actor'],text:`Attributed ${npc} testimony.`,originIds:[id],recipients:['player',npc as 'duy'|'phuc'|'hanh']};
  const serialized=serializeMemoryRecord(record);await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[f.run.id,eventId,f.run.userId,sequence,'fixture',{},'fixture']);
  const c=await pool.connect();try{await repo.insertRecord(c,record,serialized.bytes,serialized.contentHash);}finally{c.release();}
  await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',[id,bindingId,namespace,'retrievable',serialized.contentHash,{recordId:id,accountBindingId:bindingId,namespace,network:'local',state:'retrievable',blobId:'fixture:'+id,contentHash:serialized.contentHash,verifiedAt:new Date().toISOString(),lastRecallAt:new Date().toISOString()}]);seen[npc]={beat,record};
 }
 await pool.query('UPDATE runs SET event_sequence=4 WHERE id=$1',[f.run.id]);
 const action={kind:'share',recipient:'phuc',recordIds:[seen.duy.record.id]},preview=await app.inject({method:'POST',url:url+'/journal/preview',headers,payload:action});expect(preview.statusCode).toBe(200);
 const shared=await app.inject({method:'POST',url:url+'/journal/actions',headers,payload:{action,expectedRevision:0,clientActionId:randomUUID(),consentHash:preview.json().consentHash}});expect(shared.statusCode).toBe(200);
 const exactApp=(await createApp(schema.parse({SESSION_SECRET:'fixture-revisit-http-secret-only-32',DATA_FILE:join(directory,'auth.json')}),undefined,undefined,undefined,{repository:repo,provider,startWorker:false,semanticChecker:async()=>({supported:true}),memoryBackend:{semantic:async(_q,ns)=>(await pool.query('SELECT m.payload_bytes,r.receipt FROM memory_records m JOIN memory_receipts r ON r.record_id=m.id WHERE r.namespace=$1',[ns])).rows.map(r=>({blobId:r.receipt.blobId,bytes:r.payload_bytes})),exact:async(blobId,ns)=>{const row=(await pool.query("SELECT m.payload_bytes FROM memory_records m JOIN memory_receipts r ON r.record_id=m.id WHERE r.namespace=$1 AND r.receipt->>'blobId'=$2",[ns,blobId])).rows[0];return {blobId,bytes:row.payload_bytes};}}})).app;
 try{
  const selected=await exactApp.inject({method:'POST',url:url+'/revisits',headers,payload:{beatId:seen.phuc.beat.beatId,expectedRevision:1,clientActionId:randomUUID()}});expect(selected.statusCode).toBe(200);
  const question={clientTurnId:randomUUID(),expectedRevision:2,npcId:'phuc',beatId:seen.phuc.beat.beatId,trigger:'player_question',message:'Please review the Duy source I reported.',presentedRecordIds:[seen.duy.record.id]};
  const turn=await exactApp.inject({method:'POST',url:url+'/turns',headers,payload:question});expect(turn.statusCode).toBe(200);
  const ack=await exactApp.inject({method:'POST',url:url+'/turns/'+turn.json().turnId+'/ack',headers,payload:{expectedRevision:3,clientActionId:randomUUID()}});expect(ack.statusCode).toBe(200);
  const hanh=await exactApp.inject({method:'POST',url:url+'/revisits',headers,payload:{beatId:seen.hanh.beat.beatId,expectedRevision:4,clientActionId:randomUUID()}});expect(hanh.statusCode).toBe(200);
  const denied=await exactApp.inject({method:'POST',url:url+'/turns',headers,payload:{...question,clientTurnId:randomUUID(),expectedRevision:5,npcId:'hanh',beatId:seen.hanh.beat.beatId}});expect(denied.statusCode).toBe(409);expect(denied.json().error).toBe('SOURCE_NOT_AVAILABLE');
  const original=(await pool.query('SELECT payload_bytes,payload FROM memory_records WHERE id=$1',[seen.duy.record.id])).rows[0];expect(original.payload.recipients).toEqual(['player','duy']);expect(original.payload_bytes).toBe(serializeMemoryRecord(seen.duy.record).bytes);
 }finally{await exactApp.close();}
});

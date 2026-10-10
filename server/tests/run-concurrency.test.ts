import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresRepository,type AuthoritativeRun} from '../src/persistence/repository.js';
import {AuthoritativeRunService} from '../src/runs/service.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
import {STORY_VERSION} from '../src/story/canon.js';
import type {MemoryRecordV2} from '../src/domain/contracts.js';
const url=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(url);
const poolA=new pg.Pool({connectionString:url,max:2}),poolB=new pg.Pool({connectionString:url,max:2});
const a=new PostgresRepository(poolA),b=new PostgresRepository(poolB),service=new AuthoritativeRunService(a);
let userId:string,run:AuthoritativeRun,bindingId:string;
function record(snapshot=run):MemoryRecordV2 {return {schemaVersion:2,id:randomUUID(),eventId:'turn-event',userId,runId:snapshot.id,sessionId:'test-session',sequence:snapshot.eventSequence+1,storyVersion:STORY_VERSION,beatId:snapshot.checkpoint.beatId,inGameDay:snapshot.checkpoint.day,createdAt:new Date().toISOString(),actor:'binh',kind:'utterance',text:'Fixture only',epistemicStatus:'said',sourceIds:[],originIds:[],recipients:['player'],entityIds:[],propositionIds:[]};}
const turnInput=(snapshot=run)=>({userId,runId:snapshot.id,expectedRevision:snapshot.revision,clientTurnId:'client-turn',eventId:'turn-event',response:{utterance:'Fixture only'},request:{message:'hello',beatId:snapshot.checkpoint.beatId},records:[record(snapshot)],bindingId,namespace:`dfm:test:${snapshot.id}`});
beforeAll(async()=>{await a.migrate();});
beforeEach(async()=>{
  await poolA.query('TRUNCATE users,legacy_imports CASCADE');
  userId=await a.upsertUser('fixture-issuer','fixture-subject');run=await service.create(userId);bindingId=randomUUID();
  await poolA.query("INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,'local','local','fixture-account')",[bindingId,userId]);
});
afterAll(async()=>{await Promise.all([poolA.end(),poolB.end()]);});
describe('real PostgreSQL authority across independent connections',()=>{
  it('reaches the physical payment gate before the farewell instead of skipping commerce',async()=>{
    const {progressionBeats}=await import('../src/runs/service.js');
    const index=progressionBeats.findIndex(b=>b.beatId==='v2.Day1_2_Lucia.10'),beat=progressionBeats[index];
    await poolA.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'dialogue'}]);
    run=await a.getRun(userId,run.id);
    const turn=await a.commitTurn(turnInput());
    const result=await service.acknowledgeTurn({userId,runId:run.id,expectedRevision:1,turnId:turn.turnId,clientActionId:'ordered-ack'});
    expect(result.run.checkpoint).toMatchObject({beatId:'v2.Day1_2_Lucia.payment.12',phase:'order',stepIndex:12});
    await expect(service.issueToken({userId,runId:run.id,expectedRevision:2,kind:'payment'})).rejects.toMatchObject({code:'ACTION_NOT_AVAILABLE'});
  });
  it('repairs a legacy farewell through real order/payment gates without forging settlement or replaying its speech',async()=>{
    const {progressionBeats}=await import('../src/runs/service.js');
    const index=progressionBeats.findIndex(b=>b.beatId==='v2.Day1_2_Lucia.16'),beat=progressionBeats[index];
    await poolA.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'dialogue'}]);
    run=await a.getRun(userId,run.id);
    const turn=await a.commitTurn({...turnInput(),response:{utterance:'Fixture only',request:{beatId:beat.beatId}}});
    await service.acknowledgeTurn({userId,runId:run.id,expectedRevision:1,turnId:turn.turnId,clientActionId:'legacy-farewell-ack'});
    expect((await a.getRun(userId,run.id)).checkpoint.phase).toBe('order');
    expect((await poolA.query('SELECT * FROM transactions WHERE run_id=$1',[run.id])).rows).toEqual([]);
    const order=await service.issueToken({userId,runId:run.id,expectedRevision:2,kind:'order'});
    await service.acceptTokenAction({userId,runId:run.id,expectedRevision:2,token:order.token,clientActionId:'repair-order'});
    const payment=await service.issueToken({userId,runId:run.id,expectedRevision:3,kind:'payment'});
    await service.acceptTokenAction({userId,runId:run.id,expectedRevision:3,token:payment.token,clientActionId:'repair-payment'});
    run=await a.getRun(userId,run.id);
    const rec={...record(),eventId:'payment-speech'};
    const spoken=await a.commitTurn({...turnInput(),eventId:'payment-speech',clientTurnId:'payment-speech',records:[rec],response:{utterance:'Fixture only',request:{beatId:run.checkpoint.beatId}}});
    const ack=await service.acknowledgeTurn({userId,runId:run.id,expectedRevision:5,turnId:spoken.turnId,clientActionId:'repair-payment-ack'});
    expect(ack.run.checkpoint.sceneId).not.toBe('Day1_2_Lucia');
    expect((await poolA.query('SELECT state FROM transactions WHERE run_id=$1',[run.id])).rows.every(r=>r.state==='settled')).toBe(true);
  });
  it('refuses production and non-loopback test URLs',()=>{
    expect(()=>assertTestDatabase('postgresql://real:secret@127.0.0.1/db')).toThrow('REFUSE_NON_TEST_DATABASE');
    expect(()=>assertTestDatabase('postgresql://dfm_test:x@example.com/dfm_test')).toThrow('REFUSE_NON_TEST_DATABASE');
  });
  it('detects the unlocked read/write lost-update regression probe',async()=>{
    const apply=async(repo:PostgresRepository,id:string)=>repo.mutateRun({userId,runId:run.id,expectedRevision:0,eventId:id,clientActionId:id,kind:'count',payload:{}},async(_c,current)=>{current.state.count=Number(current.state.count??0)+1;return current.state.count;});
    if(process.env.DFM_TEST_UNSAFE_PROBE==='1') {
      // Deliberately reproduce the absent CAS/row-lock bug against two actual PG sessions.
      const snapshots=await Promise.all([a.getRun(userId,run.id),b.getRun(userId,run.id)]);
      await Promise.all([poolA.query('UPDATE runs SET state=$2 WHERE id=$1',[run.id,{count:Number(snapshots[0].state.count??0)+1}]),poolB.query('UPDATE runs SET state=$2 WHERE id=$1',[run.id,{count:Number(snapshots[1].state.count??0)+1}])]);
      expect((await a.getRun(userId,run.id)).state.count).toBe(2);return;
    }
    const results=await Promise.allSettled([apply(a,'one'),apply(b,'two')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('REVISION_CONFLICT');
    const current=await a.getRun(userId,run.id);expect(current.state.count).toBe(1);expect(current.eventSequence).toBe(1);
  });
  it('same turn commits once with two workers; turn/event/record/outbox all atomic',async()=>{
    const input=turnInput();const results=await Promise.all([a.commitTurn(input),b.commitTurn(input)]);
    expect(results[0].turnId).toBe(results[1].turnId);expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    for(const table of ['turns','domain_events','memory_records','outbox_jobs'])expect(Number((await poolA.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(1);
    expect((await a.getRun(userId,run.id)).revision).toBe(1);
  });
  it('duplicate ACK across workers advances exactly once and lost ACK replays safely',async()=>{
    const turn=await a.commitTurn(turnInput());const input={userId,runId:run.id,expectedRevision:1,turnId:turn.turnId,clientActionId:'ack'};
    const secondService=new AuthoritativeRunService(b);
    const replies=await Promise.all([service.acknowledgeTurn(input),secondService.acknowledgeTurn(input)]);
    expect(replies.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect((await service.resume(userId,run.id)).checkpoint.scheduleIndex).toBe(1);
    expect((await service.resume(userId,run.id)).revision).toBe(2);
    expect((await service.acknowledgeTurn(input)).replayed).toBe(true);
  });
  it('a reply generated before another commit is rejected without leaking rows',async()=>{
    const stale=turnInput();const winner=await a.commitTurn({...stale,clientTurnId:'winner',eventId:'winner-event',records:stale.records.map(r=>({...r,eventId:'winner-event'}))});
    await service.acknowledgeTurn({userId,runId:run.id,expectedRevision:1,turnId:winner.turnId,clientActionId:'winner-ack'});
    await expect(b.commitTurn(stale)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(Number((await poolA.query('SELECT count(*) FROM turns')).rows[0].count)).toBe(1);
  });
  it('a distinct turn cannot strand an outstanding ACK even with a refreshed revision',async()=>{
    const input=turnInput(),first=await a.commitTurn(input),current=await b.getRun(userId,run.id);
    const next=turnInput(current);next.clientTurnId='second-turn';next.eventId='second-event';next.records=next.records.map(r=>({...r,eventId:next.eventId}));
    await expect(b.commitTurn(next)).rejects.toMatchObject({code:'TURN_ACK_REQUIRED'});
    await expect(service.issueToken({userId,runId:run.id,expectedRevision:current.revision,kind:'checkpoint'})).rejects.toMatchObject({code:'TURN_ACK_REQUIRED'});
    expect((await a.commitTurn(input)).turnId).toBe(first.turnId);
    expect((await service.acknowledgeTurn({userId,runId:run.id,expectedRevision:current.revision,turnId:first.turnId,clientActionId:'first-ack'})).replayed).toBe(false);
    expect((await a.getRun(userId,run.id)).checkpoint.scheduleIndex).toBe(1);
  });
  it('forged record day and foreign binding roll back entire turn',async()=>{
    const input=turnInput();input.records[0].inGameDay=6;await expect(a.commitTurn(input)).rejects.toMatchObject({code:'RECORD_SCOPE_MISMATCH'});
    const foreign=await a.upsertUser('fixture','other'),foreignBinding=randomUUID();await poolA.query("INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,'local','local','foreign')",[foreignBinding,foreign]);
    await expect(a.commitTurn({...turnInput(),bindingId:foreignBinding})).rejects.toThrow();
    expect((await a.getRun(userId,run.id)).revision).toBe(0);
    for(const table of ['turns','domain_events','memory_records','outbox_jobs'])expect(Number((await poolA.query(`SELECT count(*) FROM ${table}`)).rows[0].count)).toBe(0);
  });
  it('crash before commit rolls back; restart after commit restores exact reply and pending write',async()=>{
    const c=await poolA.connect();await c.query('BEGIN');await c.query('UPDATE runs SET revision=999 WHERE id=$1',[run.id]);c.release(true);
    expect((await b.getRun(userId,run.id)).revision).toBe(0);
    const input=turnInput(),reply=await a.commitTurn(input);
    const restartPool=new pg.Pool({connectionString:url});try {
      const restarted=new PostgresRepository(restartPool);expect((await restarted.commitTurn(input)).turnId).toBe(reply.turnId);
      expect((await restarted.getTurn(userId,run.id,input.clientTurnId)).response).toEqual(input.response);
      expect((await restartPool.query('SELECT state FROM outbox_jobs')).rows[0].state).toBe('queued');
    }finally {await restartPool.end();}
  });
  it('a broken connection is evicted and the next operation reconnects',async()=>{
    const c=await poolB.connect();await c.query('SELECT 1');c.release(true);
    expect((await b.getRun(userId,run.id)).id).toBe(run.id);
  });
  it('server order/payment tokens reject future phase and duplicate delivery/payment',async()=>{
    // Server fixture checkpoint, never client request day: reach the canonical payment gate directly for this isolated scenario.
    const {progressionBeats}=await import('../src/runs/service.js');const index=progressionBeats.findIndex(b=>b.kind==='payment');const beat=progressionBeats[index];
    await poolA.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'order'}]);
    await expect(service.issueToken({userId,runId:run.id,expectedRevision:0,kind:'payment'})).rejects.toMatchObject({code:'ACTION_NOT_AVAILABLE'});
    const order=await service.issueToken({userId,runId:run.id,expectedRevision:0,kind:'order'});const action={userId,runId:run.id,expectedRevision:0,token:order.token,clientActionId:'delivery'};
    const replies=await Promise.all([service.acceptTokenAction(action),new AuthoritativeRunService(b).acceptTokenAction(action)]);expect(replies.map(r=>r.replayed).sort()).toEqual([false,true]);
    await expect(service.acceptTokenAction({...action,expectedRevision:1,clientActionId:'other-delivery'})).rejects.toMatchObject({code:'TOKEN_INVALID'});
    const payment=await service.issueToken({userId,runId:run.id,expectedRevision:1,kind:'payment'});const pay={userId,runId:run.id,expectedRevision:1,token:payment.token,clientActionId:'payment'};
    await Promise.all([service.acceptTokenAction(pay),new AuthoritativeRunService(b).acceptTokenAction(pay)]);
    const ledger=await poolA.query('SELECT * FROM transactions');expect(ledger.rows.every(r=>r.state==='settled')).toBe(true);expect(ledger.rows.reduce((n,r)=>n+r.paid_amount-r.accepted_change,0)).toBe(ledger.rows.reduce((n,r)=>n+r.unit_price*r.quantity,0));
    expect((await service.resume(userId,run.id)).revision).toBe(2);
  });
  it('scoped IDs cannot mutate another user run; reused action payload conflicts',async()=>{
    const other=await a.upsertUser('fixture','other');await expect(a.getRun(other,run.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    const input={userId,runId:run.id,expectedRevision:0,eventId:'event',clientActionId:'action',kind:'test',payload:{value:1}};await a.mutateRun(input,async()=>({ok:true}));
    await expect(b.mutateRun({...input,payload:{value:2}},async()=>({ok:true}))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('legacy single row import is explicit, replay-safe, preserved and blocked for reconciliation',async()=>{
    const legacy={users:{old:{id:'old',name:'Old'}},runs:{oldrun:{id:'oldrun',userId:'old',day:6,cursor:99,revision:3,records:[],shares:[],turns:[]}},localMemories:{}};
    await poolA.query('CREATE TABLE IF NOT EXISTS dfm_state(id integer PRIMARY KEY,body jsonb NOT NULL)');await poolA.query('INSERT INTO dfm_state VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET body=$1',[legacy]);
    expect((await a.importLegacyTable()).replayed).toBe(false);expect((await b.importLegacyTable()).replayed).toBe(true);
    expect((await a.getRun('old','oldrun')).status).toBe('requires_reconciliation');expect((await poolA.query('SELECT body FROM dfm_state')).rows[0].body).toEqual(legacy);
  });
});

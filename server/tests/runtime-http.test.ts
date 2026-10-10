import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {schema} from '../src/config.js';
import {PostgresRepository} from '../src/persistence/repository.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
import {progressionBeats} from '../src/runs/service.js';
import type {DialogueProvider} from '../src/dialogue/provider.js';
import type {SemanticChecker} from '../src/dialogue/contracts.js';
import type {PromptMessage} from '../src/dialogue/prompt.js';
import type {FastifyInstance} from 'fastify';

// An actual isolated PG schema, never a mock repository or shared TRUNCATE.
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace='runtime_http_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:database});
const pool=new pg.Pool({connectionString:database,options:`-c search_path=${namespace},public`});
const repository=new PostgresRepository(pool);
let directory:string;
let apps:FastifyInstance[]=[];
class LiteralProvider implements DialogueProvider {
 readonly modelId='fixture-literal-v1';
 calls=0;
 entered?:()=>void;
 wait?:Promise<void>;
 paymentContext?:{orderId:string;total:number;paidAmount:number;acceptedChange:number};
 async complete(messages:PromptMessage[]) {
  this.calls++;this.entered?.();await this.wait;
  const packet=JSON.parse(messages[1].content);
  if(packet.validatedTransaction){
   this.paymentContext=packet.validatedTransaction;
   return {utterance:paymentUtterance(packet.validatedTransaction),sourceIds:[],expressedPropositionIds:[],intent:'answer',actions:[]};
  }
  const proposition=packet.authorizedPropositions[0];
  if(!proposition)throw new Error('Fixture requires current authorized proposition');
  return {utterance:proposition.meaning,sourceIds:[],expressedPropositionIds:[proposition.id],intent:'answer',actions:[]};
 }
}
function paymentUtterance(tx:{total:number;paidAmount:number;acceptedChange:number}){return `Payment received: ${tx.paidAmount} VND for a total of ${tx.total} VND; change is ${tx.acceptedChange} VND.`;}
// The fixture checker admits one exact rendering of the actual server ledger;
// it cannot approve arbitrary speech, invented amounts, actions, or citations.
const fixtureChecker:SemanticChecker=async(turn,context)=>({supported:Boolean(context.validatedTransaction&&turn.utterance===paymentUtterance(context.validatedTransaction)&&turn.actions.length===0&&turn.sourceIds.length===0&&turn.expressedPropositionIds.length===0)});
const memoryBackend={semantic:async()=>[]};
async function launch(provider?:DialogueProvider){
 const c=schema.parse({SESSION_SECRET:'fixture-runtime-session-key-only-32',DATA_FILE:join(directory,'auth.json')});
 // Keep absent-route failures behavioral while the optional fifth argument lands.
 const built=await createApp(c,undefined,undefined,undefined,{repository,provider,semanticChecker:fixtureChecker,memoryBackend,startWorker:false});
 apps.push(built.app);return built.app;
}
type App=FastifyInstance;
async function login(app:App,name='alice'){
 const response=await app.inject({method:'POST',url:'/v1/session',payload:{name,accessCode:`fixture-${name}-access-code`}});
 expect(response.statusCode).toBe(200);const data=response.json();
 const token=data.accessToken??data.token;expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
 return {authorization:`Bearer ${token}`};
}
async function createRun(app:App,headers:Record<string,string>){
 const response=await app.inject({method:'POST',url:'/v2/runs',headers,payload:{}});
 expect(response.statusCode).toBe(200);return response.json().run??response.json();
}
function question(run:any,id=randomUUID()){
 const beat=progressionBeats[run.checkpoint.scheduleIndex];
 return {clientTurnId:id,expectedRevision:run.revision,npcId:beat.npcId,trigger:'arrival',message:'Please explain the current situation.',beatId:beat.beatId,presentedRecordIds:[]};
}
async function rowCounts(){const tables=['turns','domain_events','memory_records','outbox_jobs'];return Object.fromEntries(await Promise.all(tables.map(async table=>[table,Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)])));}
beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'dfm-runtime-http-'));await admin.query(`CREATE SCHEMA ${namespace}`);await repository.migrate();});
beforeEach(async()=>{for(const app of apps)await app.close();apps=[];await pool.query('TRUNCATE users,legacy_imports CASCADE');await rm(join(directory,'auth.json'),{force:true});});
afterAll(async()=>{for(const app of apps)await app.close();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});});

it('advertises authoritative runtime and enforces login and owner scope',async()=>{
 const app=await launch(new LiteralProvider());
 const status=await app.inject({url:'/v2/runtime'});expect(status.statusCode).toBe(200);expect(status.json().enabled).toBe(true);
 expect((await app.inject({method:'POST',url:'/v2/runs',payload:{}})).statusCode).toBe(401);
 const alice=await login(app),bob=await login(app,'bob'),run=await createRun(app,alice);
 expect((await app.inject({url:`/v2/runs/${run.id}`,headers:alice})).statusCode).toBe(200);
 expect([403,404]).toContain((await app.inject({url:`/v2/runs/${run.id}`,headers:bob})).statusCode);
 expect(Number((await pool.query('SELECT count(*) FROM runs')).rows[0].count)).toBe(1);
});

it('authority restore authenticates before reading backups and refuses an unavailable recovery adapter',async()=>{
 const app=await launch(),payload={confirmed:true,userId:randomUUID(),runId:randomUUID()};
 expect((await app.inject({method:'POST',url:'/v2/memory/authority/restore',payload})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:'/v2/memory/authority/restore',headers:{authorization:'Bearer invalid'},payload})).statusCode).toBe(401);
 const headers=await login(app);const denied=await app.inject({method:'POST',url:'/v2/memory/authority/restore',headers,payload});
 expect(denied.statusCode).toBe(503);expect(denied.json().error).toBe('EXACT_RECOVERY_UNAVAILABLE');
});
it('does not substitute static speech when no LLM is available',async()=>{
 const app=await launch(),headers=await login(app),run=await createRun(app,headers);
 const result=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:question(run)});
 expect(result.statusCode).toBe(503);expect(result.json().utterance).toBeUndefined();
 expect(await rowCounts()).toEqual({turns:0,domain_events:0,memory_records:0,outbox_jobs:0});
});
it('commits exact generated speech and raw player message once, durably replays lost response, then ACK advances once',async()=>{
 const provider=new LiteralProvider(),app=await launch(provider),headers=await login(app),run=await createRun(app,headers),request=question(run);
 const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:request})));
 for(const response of responses)expect(response.statusCode).toBe(200);
 const reply=responses[0].json();expect(responses[1].json()).toEqual(reply);expect(reply.generation).toBe('llm');
 const rows=(await pool.query('SELECT payload FROM memory_records ORDER BY sequence,id')).rows.map(row=>row.payload);
 expect(rows.some(row=>row.actor==='player'&&row.text===request.message)).toBe(true);
 expect(rows.some(row=>row.actor===request.npcId&&row.text===reply.utterance&&row.epistemicStatus==='said')).toBe(true);
 const counts=await rowCounts();expect(counts.turns).toBe(1);expect(counts.domain_events).toBe(1);expect(counts.memory_records).toBeGreaterThanOrEqual(2);expect(counts.outbox_jobs).toBe(counts.memory_records);
 const conflict=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:{...request,message:'A different question with the same request id.'}});
 expect(conflict.statusCode).toBe(409);expect(await rowCounts()).toEqual(counts);
 await app.close();apps=apps.filter(candidate=>candidate!==app);
 const restarted=await launch(provider),freshHeaders=await login(restarted);
 const replay=await restarted.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers:freshHeaders,payload:request});expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(reply);
 expect(await rowCounts()).toEqual(counts);
 const ack={expectedRevision:reply.runRevision,clientActionId:'fixture-ack'};
 const replies=await Promise.all([1,2].map(()=>restarted.inject({method:'POST',url:`/v2/runs/${run.id}/turns/${reply.turnId}/ack`,headers:freshHeaders,payload:ack})));
 for(const response of replies)expect(response.statusCode).toBe(200);
 const resumed=await repository.getRun(run.userId,run.id);expect(resumed.checkpoint.scheduleIndex).toBe(1);expect(resumed.revision).toBe(reply.runRevision+1);
});
it('revoking session during generation rejects commit and leaves no turn/outbox rows',async()=>{
 const provider=new LiteralProvider();let release!:()=>void;let entered!:()=>void;
 provider.wait=new Promise<void>(resolve=>release=resolve);const began=new Promise<void>(resolve=>entered=resolve);provider.entered=entered;
 const app=await launch(provider),headers=await login(app),run=await createRun(app,headers);
 const pending=app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:question(run)});
 await Promise.race([began,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Generation never reached provider')),2000))]);
 try{expect((await app.inject({method:'POST',url:'/v1/auth/logout',headers,payload:{}})).statusCode).toBe(200);}finally{release();}
 const rejected=await pending;expect([401,403],rejected.body).toContain(rejected.statusCode);expect(await rowCounts()).toEqual({turns:0,domain_events:0,memory_records:0,outbox_jobs:0});
});
it('rejects future beats and foreign presented sources before any generation or write',async()=>{
 const provider=new LiteralProvider(),app=await launch(provider),headers=await login(app),run=await createRun(app,headers);
 const foreignHeaders=await login(app,'foreign-source-owner'),foreignRun=await createRun(app,foreignHeaders);
 const foreignTurn=await app.inject({method:'POST',url:`/v2/runs/${foreignRun.id}/turns`,headers:foreignHeaders,payload:question(foreignRun)});expect(foreignTurn.statusCode).toBe(200);
 const foreignRecord=(await pool.query('SELECT id FROM memory_records WHERE run_id=$1 LIMIT 1',[foreignRun.id])).rows[0].id;
 const baseline=await rowCounts(),calls=provider.calls;
 for(const payload of [{...question(run),beatId:progressionBeats.at(-1)!.beatId},{...question(run),presentedRecordIds:[foreignRecord]}]){
  const response=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload});expect([400,403,409,422]).toContain(response.statusCode);
 }
 expect(provider.calls).toBe(calls);expect(await rowCounts()).toEqual(baseline);
});
it('payment gate requires delivery then payment, with durable duplicate action replay',async()=>{
 const provider=new LiteralProvider(),app=await launch(provider),headers=await login(app),run=await createRun(app,headers);
 const index=progressionBeats.findIndex(beat=>beat.kind==='payment'),beat=progressionBeats[index];
 await pool.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'order'}]);
 const token=async(kind:string,revision:number)=>app.inject({method:'POST',url:`/v2/runs/${run.id}/tokens`,headers,payload:{kind,expectedRevision:revision}});
 expect((await token('payment',0)).statusCode).toBe(409);
 const premature=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:{...question({...run,checkpoint:{...run.checkpoint,scheduleIndex:index}}),trigger:'payment'}});expect(premature.statusCode,premature.body).toBe(409);expect(provider.calls).toBe(0);
 const delivery=await token('order',0);expect(delivery.statusCode).toBe(200);
 const deliverPayload={token:delivery.json().token,expectedRevision:0,clientActionId:'fixture-deliver'};
 const act=async(payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/v2/runs/${run.id}/actions`,headers,payload});
 expect((await act(deliverPayload)).statusCode).toBe(200);expect((await act(deliverPayload)).statusCode).toBe(200);
 const delivered=await repository.getRun(run.userId,run.id);expect(delivered.checkpoint.scheduleIndex).toBe(index);expect(delivered.checkpoint.phase).toBe('payment');
 const payment=await token('payment',1);expect(payment.statusCode).toBe(200);
 const pay={token:payment.json().token,expectedRevision:1,clientActionId:'fixture-pay'};
 expect((await act(pay)).statusCode).toBe(200);expect((await act(pay)).statusCode).toBe(200);
 const paid=await repository.getRun(run.userId,run.id);expect(paid.checkpoint.scheduleIndex).toBe(index);expect(paid.checkpoint.phase).toBe('dialogue');expect(paid.revision).toBe(2);
 expect((await pool.query('SELECT DISTINCT state FROM transactions')).rows).toEqual([{state:'settled'}]);
 const speech=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:{...question(paid),trigger:'payment'}});expect(speech.statusCode,speech.body).toBe(200);
 const ledger=await pool.query('SELECT sum(quantity*unit_price)::int total,sum(paid_amount)::int paid,sum(accepted_change)::int change FROM transactions WHERE run_id=$1',[run.id]);
 expect(provider.paymentContext).toEqual({orderId:`${run.id}:${beat.sceneId}`,total:ledger.rows[0].total,paidAmount:ledger.rows[0].paid,acceptedChange:ledger.rows[0].change});
 expect(speech.json().utterance).toBe(paymentUtterance(provider.paymentContext!));
 const ack=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns/${speech.json().turnId}/ack`,headers,payload:{expectedRevision:speech.json().runRevision,clientActionId:'fixture-payment-ack'}});expect(ack.statusCode).toBe(200);
 expect((await repository.getRun(run.userId,run.id)).checkpoint).toMatchObject({sceneId:beat.sceneId,stepIndex:14,phase:'dialogue'});
});
it('a server checkpoint token accepts one authorized choice and advances exactly once',async()=>{
 const app=await launch(new LiteralProvider()),headers=await login(app),run=await createRun(app,headers);
 const index=progressionBeats.findIndex(beat=>beat.kind==='player_input'),beat=progressionBeats[index];
 await pool.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'dialogue'}]);
 const issued=await app.inject({method:'POST',url:`/v2/runs/${run.id}/tokens`,headers,payload:{kind:'checkpoint',expectedRevision:0}});expect(issued.statusCode,issued.body).toBe(200);
 const action={token:issued.json().token,expectedRevision:0,clientActionId:'fixture-choice',intent:beat.actionIntents[0]};
 const denied=await app.inject({method:'POST',url:`/v2/runs/${run.id}/actions`,headers,payload:{...action,intent:'fixture-not-authorized',clientActionId:'fixture-invalid-choice'}});expect(denied.statusCode,denied.body).toBe(409);
 expect((await repository.getRun(run.userId,run.id)).revision).toBe(0);
 const response=await app.inject({method:'POST',url:`/v2/runs/${run.id}/actions`,headers,payload:action});expect(response.statusCode,response.body).toBe(200);
 const replay=await app.inject({method:'POST',url:`/v2/runs/${run.id}/actions`,headers,payload:action});expect(replay.statusCode,replay.body).toBe(200);
 const resumed=await repository.getRun(run.userId,run.id);expect(resumed.revision).toBe(1);expect(resumed.checkpoint.scheduleIndex).toBe(index+1);
 expect(Number((await pool.query('SELECT count(*) FROM domain_events')).rows[0].count)).toBe(1);
});
it('free question ACK retains story checkpoint and a new device lists the same owned run',async()=>{
 const app=await launch(new LiteralProvider()),headers=await login(app),run=await createRun(app,headers);
 const response=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:{...question(run),trigger:'player_question'}});
 expect(response.statusCode,response.body).toBe(200);
 const ack=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns/${response.json().turnId}/ack`,headers,payload:{expectedRevision:response.json().runRevision}});
 expect(ack.statusCode,ack.body).toBe(200);expect(ack.json().nextEvent.beatId).toBe(run.checkpoint.beatId);
 const device=await login(app);
 expect((await app.inject({url:'/v2/runs',headers:device})).json().runs).toEqual([{id:run.id}]);
 const other=await login(app,'bob');expect((await app.inject({url:'/v2/runs',headers:other})).json().runs).toEqual([]);
});

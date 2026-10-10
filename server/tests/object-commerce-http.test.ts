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
import {sceneStock} from '../src/story/objects.js';
import {progressionBeats} from '../src/runs/service.js';
import type {DialogueProvider} from '../src/dialogue/provider.js';
import type {SemanticChecker} from '../src/dialogue/contracts.js';
import type {PromptMessage} from '../src/dialogue/prompt.js';
import type {FastifyInstance} from 'fastify';

// An actual isolated PG schema, never a mock repository or shared TRUNCATE.
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace='object_commerce_http_'+randomUUID().replaceAll('-','');
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
const fixtureChecker:SemanticChecker=async(turn,context)=>({supported:turn.actions.length===0&&turn.sourceIds.length===0&&context.packet.authorizedPropositions.some(p=>p.meaning===turn.utterance&&turn.expressedPropositionIds.includes(p.id))});
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

it('object endpoints require owner, validate input, CAS and durable replay without minting stock',async()=>{
 const app=await launch(new LiteralProvider()),headers=await login(app),foreign=await login(app,'foreign'),run=await createRun(app,headers);
 const url=`/v2/runs/${run.id}/objects`;
 expect((await app.inject({url})).statusCode).toBe(401);
 expect([403,404]).toContain((await app.inject({url,headers:foreign})).statusCode);
 const payload={expectedRevision:0,clientActionId:'bind-one',itemId:'coffee_strip',clientSlot:sceneStock.slots.find(s=>s.itemId==='coffee_strip')!.slotId,quantity:1};
 const send=(body:any,h=headers)=>app.inject({method:'POST',url:url+'/bind',headers:h,payload:body});
 expect([403,404]).toContain((await send(payload,foreign)).statusCode);
 expect((await send({...payload,quantity:100})).statusCode).toBe(400);
 expect((await send({...payload,itemId:'invented'})).statusCode).toBe(409);
 const bound=await send(payload);expect(bound.statusCode,bound.body).toBe(200);const item=bound.json().result.item;
 expect((await send(payload)).json().replayed).toBe(true);
 expect((await send({...payload,quantity:3})).statusCode).toBe(409);
 expect((await send({...payload,clientActionId:'stale'})).statusCode).toBe(409);
 const inv=(await app.inject({url,headers})).json();expect(inv.instances).toHaveLength(1);expect(inv.instances[0]).toMatchObject({instanceId:item.instanceId,quantity:1});
 const hold=(instanceId:string|null,expectedRevision=1)=>app.inject({method:'POST',url:url+'/hold',headers,payload:{instanceId,expectedRevision,clientActionId:randomUUID()}});
 expect((await hold('foreign-instance')).statusCode).toBe(409);expect((await hold(null)).statusCode).toBe(200);
 expect((await hold(item.instanceId,2)).statusCode).toBe(200);expect((await repository.getRun(run.userId,run.id)).checkpoint).toEqual(run.checkpoint);
});

it('shown object reaches dialogue prompt and ACK retains cursor, stock and unpaid state',async()=>{
 const provider=new LiteralProvider();let seen:any;const original=provider.complete.bind(provider);provider.complete=async messages=>{seen=JSON.parse(messages[1].content);return original(messages);};
 const app=await launch(provider),headers=await login(app),run=await createRun(app,headers);
 const bind=await app.inject({method:'POST',url:`/v2/runs/${run.id}/objects/bind`,headers,payload:{expectedRevision:0,clientActionId:'show-bind',itemId:'coffee_strip',clientSlot:sceneStock.slots.find(s=>s.itemId==='coffee_strip')!.slotId,quantity:1}});expect(bind.statusCode,bind.body).toBe(200);
 const item=bind.json().result.item;const request={...question({...run,revision:1}),trigger:'object_shown',heldItemInstanceId:item.instanceId};
 const turn=await app.inject({method:'POST',url:`/v2/runs/${run.id}/turns`,headers,payload:request});expect(turn.statusCode,turn.body).toBe(200);expect(seen.shownObject).toMatchObject({instanceId:item.instanceId,itemId:'coffee_strip',meaning:'shown_only_not_delivered_or_paid'});
 const locked=await app.inject({method:'POST',url:`/v2/runs/${run.id}/objects/hold`,headers,payload:{expectedRevision:turn.json().runRevision,clientActionId:'before-ack',instanceId:null}});expect(locked.statusCode).toBe(409);
 const ack={expectedRevision:turn.json().runRevision,clientActionId:'object-ack'};const endpoint=`/v2/runs/${run.id}/turns/${turn.json().turnId}/ack`;
 expect((await app.inject({method:'POST',url:endpoint,headers,payload:ack})).statusCode).toBe(200);expect((await app.inject({method:'POST',url:endpoint,headers,payload:ack})).statusCode).toBe(200);
 const fresh=await repository.getRun(run.userId,run.id);expect(fresh.checkpoint).toEqual(run.checkpoint);expect((fresh.state.physicalObjects as any).instances[0]).toMatchObject({quantity:1,status:'available'});expect(fresh.state.validatedPayment).toBeUndefined();
});

it('commerce edits invalidate earlier quote; reservation cancellation preserves stock with scoped CAS replay',async()=>{
 const app=await launch(),headers=await login(app),foreign=await login(app,'foreign'),run=await createRun(app,headers);
 const index=progressionBeats.findIndex(b=>b.orderContract),beat=progressionBeats[index];await pool.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'order'}]);
 const url=`/v2/runs/${run.id}/commerce`;expect((await app.inject({url})).statusCode).toBe(401);expect([403,404]).toContain((await app.inject({url,headers:foreign})).statusCode);
 const quote=await app.inject({method:'POST',url:`/v2/runs/${run.id}/tokens`,headers,payload:{kind:'order',expectedRevision:0}});expect(quote.statusCode,quote.body).toBe(200);
 const action=(action:any,expectedRevision:number,id:string=randomUUID(),h=headers)=>app.inject({method:'POST',url:url+'/actions',headers:h,payload:{action,expectedRevision,clientActionId:id}});
 const change={kind:'change_order',lines:[{itemId:'coffee_strip',quantity:2}]};expect([403,404]).toContain((await action(change,0,'foreign',foreign)).statusCode);
 expect((await action({kind:'change_order',lines:[{itemId:'invented',quantity:2}]},0)).statusCode).toBe(409);
 expect((await action(change,0,'edit')).statusCode).toBe(200);expect((await action(change,0,'edit')).json().replayed).toBe(true);expect((await action(change,0)).statusCode).toBe(409);
 const expired=await app.inject({method:'POST',url:`/v2/runs/${run.id}/actions`,headers,payload:{token:quote.json().token,expectedRevision:1,clientActionId:'old-quote'}});expect(expired.statusCode).toBe(409);
 expect((await app.inject({url,headers})).json().orderItems).toEqual({coffee_strip:2});
 const bound=await app.inject({method:'POST',url:`/v2/runs/${run.id}/objects/bind`,headers,payload:{expectedRevision:1,clientActionId:'reserve-bind',itemId:'coffee_strip',clientSlot:sceneStock.slots.find(s=>s.itemId==='coffee_strip')!.slotId,quantity:1}});expect(bound.statusCode,bound.body).toBe(200);
 const reserved=await action({kind:'reserve',instanceId:bound.json().result.item.instanceId},2,'reserve');expect(reserved.statusCode,reserved.body).toBe(200);const id=reserved.json().result.result.id;
 expect((await action({kind:'fulfill_reservation',reservationId:id},3)).statusCode).toBe(409);expect((await action({kind:'cancel_reservation',reservationId:'foreign'},3)).statusCode).toBe(409);
 const cancelled=await action({kind:'cancel_reservation',reservationId:id},3,'cancel');expect(cancelled.statusCode,cancelled.body).toBe(200);expect((await action({kind:'cancel_reservation',reservationId:id},3,'cancel')).json().replayed).toBe(true);
 expect((await action({kind:'fulfill_reservation',reservationId:id},4)).statusCode).toBe(409);expect((await pool.query('SELECT count(*)::int n FROM memory_records WHERE run_id=$1',[run.id])).rows[0].n).toBe(0);
 expect((await app.inject({url:`/v2/runs/${run.id}/objects`,headers})).json().instances[0]).toMatchObject({quantity:1,status:'available'});
});

it('later same-NPC reservation fulfillment consumes once and creates one attributed durable cause',async()=>{
 const app=await launch(),headers=await login(app),run=await createRun(app,headers);
 const first=progressionBeats.findIndex(b=>b.npcId==='binh'),beat=progressionBeats[first];
 const later=progressionBeats.findIndex((b,i)=>i>first&&b.npcId==='binh'&&b.sceneId!==beat.sceneId);expect(later).toBeGreaterThan(first);
 const checkpoint=(i:number)=>{const b=progressionBeats[i];return {beatId:b.beatId,day:b.day,sceneId:b.sceneId,stepIndex:b.stepIndex,scheduleIndex:i,phase:'dialogue'};};
 await pool.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,checkpoint(first)]);
 const bind=await app.inject({method:'POST',url:`/v2/runs/${run.id}/objects/bind`,headers,payload:{expectedRevision:0,clientActionId:'fulfill-bind',itemId:'coffee_strip',clientSlot:sceneStock.slots.find(s=>s.itemId==='coffee_strip')!.slotId,quantity:1}});expect(bind.statusCode,bind.body).toBe(200);
 const action=(action:any,expectedRevision:number,clientActionId:string)=>app.inject({method:'POST',url:`/v2/runs/${run.id}/commerce/actions`,headers,payload:{action,expectedRevision,clientActionId}});
 const reserve=await action({kind:'reserve',instanceId:bind.json().result.item.instanceId},1,'fulfill-reserve');expect(reserve.statusCode,reserve.body).toBe(200);
 await pool.query('UPDATE runs SET checkpoint=$2 WHERE id=$1',[run.id,checkpoint(later)]);
 const request={kind:'fulfill_reservation',reservationId:reserve.json().result.result.id};
 const result=await action(request,2,'fulfill');expect(result.statusCode,result.body).toBe(200);expect((await action(request,2,'fulfill')).json().replayed).toBe(true);
 expect((await action(request,3,'fulfill-again')).statusCode).toBe(409);
 const records=(await pool.query('SELECT payload FROM memory_records WHERE run_id=$1',[run.id])).rows.map(r=>r.payload);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({actor:'player',kind:'relationship',recipients:['player','binh']});expect(JSON.parse(records[0].text)).toMatchObject({outcome:'reservation_kept'});
 expect((await pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE run_id=$1',[run.id])).rows[0].n).toBe(1);
 expect((await app.inject({url:`/v2/runs/${run.id}/objects`,headers})).json().instances[0]).toMatchObject({quantity:1,status:'consumed'});
});





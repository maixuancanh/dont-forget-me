import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
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
import {MemoryOperations,type OperationsSdk} from '../src/memory/operations.js';

const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace='memory_http_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:database});
const pool=new pg.Pool({connectionString:database,options:`-c search_path=${namespace},public`});
const repository=new PostgresRepository(pool);
let directory:string;let apps:FastifyInstance[]=[];
beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'dfm-memory-http-'));await admin.query(`CREATE SCHEMA ${namespace}`);await repository.migrate();});
beforeEach(async()=>{for(const app of apps)await app.close();apps=[];await pool.query('TRUNCATE users,legacy_imports CASCADE');await rm(join(directory,'auth.json'),{force:true});});
afterAll(async()=>{for(const app of apps)await app.close();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});});

function sdkFixture(){
 const calls:Array<{kind:string;text?:string;namespace?:string}>=[];let fail=false;let listed:string[]=[];
 const sdk:OperationsSdk={
  analyzeAndWait:async(text,options)=>{const namespace=typeof options==='string'?options:options?.namespace??'';calls.push({kind:'analyze',text,namespace});if(fail)throw new Error('fixture timeout after external upload');return{owner:'ownerfixture',facts:[{id:'candidate',text:'Unreviewed candidate only'}],results:[{id:'candidate',blob_id:'candidate-blob',namespace,status:'done'}],total:1,succeeded:1,failed:0};},
  restore:async(namespace)=>{calls.push({kind:'restore',namespace});return{owner:'ownerfixture',namespace,restored:0,skipped:0,failed:0,total:0,truncated:false};},
  listNamespaces:async(options)=>{calls.push({kind:'list'});return{namespaces:listed.map((name,i)=>({id:String(i),name,memory_count:1,storage_used:2,updated_at:'2026-10-09'})),has_more:!options?.cursor,next_cursor:options?.cursor?null:'fixture-next',snapshot_version:1};},
 };
 return{calls,ops:new MemoryOperations(sdk,'fixture-http-cursor-signing-key-only-32'),fail:()=>{fail=true;},list:(names:string[])=>{listed=names;}};
}
async function launch(ops?:MemoryOperations){const c=schema.parse({SESSION_SECRET:'fixture-memory-http-session-key-only-32',DATA_FILE:join(directory,'auth.json')});const built=await createApp(c,undefined,undefined,undefined,{repository,memoryBackend:{semantic:async()=>[]},startWorker:false,...(ops?{memoryOperations:ops,memoryOperationOwner:async()=>'ownerfixture'}:{})});apps.push(built.app);return built.app;}
async function login(app:FastifyInstance,name='alice'){const response=await app.inject({method:'POST',url:'/v1/session',payload:{name,accessCode:`fixture-${name}-only`}});expect(response.statusCode).toBe(200);const d=response.json();return{authorization:`Bearer ${d.accessToken??d.token}`};}
async function run(app:FastifyInstance,headers:Record<string,string>){const response=await app.inject({method:'POST',url:'/v2/runs',headers,payload:{}});expect(response.statusCode).toBe(200);return response.json().run??response.json();}
async function note(app:FastifyInstance,headers:Record<string,string>,runId:string,text='Exact player note. Untrusted hypothesis.'){
 const action={kind:'note',text,recordIds:[]};const preview=await app.inject({method:'POST',url:`/v2/runs/${runId}/journal/preview`,headers,payload:action});expect(preview.statusCode).toBe(200);
 const p=preview.json();const commit=await app.inject({method:'POST',url:`/v2/runs/${runId}/journal/actions`,headers,payload:{action,expectedRevision:p.revision,consentHash:p.consentHash,clientActionId:randomUUID()}});expect(commit.statusCode).toBe(200);
 const journal=await app.inject({url:`/v2/runs/${runId}/journal`,headers});expect(journal.statusCode).toBe(200);return journal.json().records.find((r:any)=>r.text===text);
}
async function analysis(app:FastifyInstance,headers:Record<string,string>,runId:string,recordId:string){
 const action={kind:'analyze',operationId:randomUUID(),rawInputRecordId:recordId};const response=await app.inject({method:'POST',url:`/v2/runs/${runId}/memory/preview`,headers,payload:action});expect(response.statusCode).toBe(200);const preview=response.json();return{action,preview,input:{action,expectedRevision:preview.scope.revision,clientActionId:randomUUID(),confirmed:true as const,confirmationHash:preview.confirmationHash}};
}
it('denies anonymous and foreign-user preview/read without external SDK work',async()=>{
 const f=sdkFixture(),app=await launch(f.ops),alice=await login(app),bob=await login(app,'bob'),r=await run(app,alice),n=await note(app,alice,r.id);
 const payload={kind:'analyze',operationId:randomUUID(),rawInputRecordId:n.id};
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/preview`,payload})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/preview`,headers:bob,payload})).statusCode).toBe(403);
 expect((await app.inject({url:`/v2/runs/${r.id}/memory/operations/not-owned`,headers:bob})).statusCode).toBe(403);
 const commit={action:payload,expectedRevision:1,clientActionId:randomUUID(),confirmed:true,confirmationHash:'0'.repeat(64)};
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/operations`,payload:commit})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/operations`,headers:bob,payload:commit})).statusCode).toBe(403);
 expect(f.calls).toHaveLength(0);
});
it('previews canonical notes only and rejects injected text and another run source',async()=>{
 const f=sdkFixture(),app=await launch(f.ops),headers=await login(app),r=await run(app,headers),other=await run(app,headers),n=await note(app,headers,r.id),foreign=await note(app,headers,other.id,'Foreign note');
 const a=await analysis(app,headers,r.id,n.id);expect(a.preview.request.text).toBe(n.text);expect(a.preview.namespace).toBe(`dfm:v2:${r.userId}:${r.id}:case:candidates:${a.action.operationId}`);expect(a.preview.disclosure).toContain('automatically stores');
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/preview`,headers,payload:{...a.action,text:'forged'}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/preview`,headers,payload:{...a.action,rawInputRecordId:foreign.id}})).statusCode).toBe(403);expect(f.calls).toHaveLength(0);
});
it('requires exact consent/revision and replays the same operation without dispatching twice or admitting candidates',async()=>{
 const f=sdkFixture(),app=await launch(f.ops),headers=await login(app),r=await run(app,headers),n=await note(app,headers,r.id),a=await analysis(app,headers,r.id,n.id),url=`/v2/runs/${r.id}/memory/operations`;
 expect((await app.inject({method:'POST',url,headers,payload:{...a.input,confirmationHash:'0'.repeat(64)}})).statusCode).toBe(409);
 expect((await app.inject({method:'POST',url,headers,payload:{...a.input,expectedRevision:a.input.expectedRevision+1}})).statusCode).toBe(409);expect(f.calls).toHaveLength(0);
 const first=await app.inject({method:'POST',url,headers,payload:a.input});expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({status:'completed',dispatchCount:1,result:{state:'awaiting_review',candidates:[{reviewState:'unreviewed',canonicalEvidence:false}]}});
 const replay=await app.inject({method:'POST',url,headers,payload:a.input});expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({status:'completed',replayed:true,dispatchCount:1});expect(f.calls).toHaveLength(1);
 const ledger=(await pool.query('SELECT payload FROM memory_records WHERE run_id=$1',[r.id])).rows;expect(ledger).toHaveLength(1);expect(ledger[0].payload.text).toBe(n.text);
});
it('reports timeout outcome as unknown and GET/replayed POST never redispatch it',async()=>{
 const f=sdkFixture(),app=await launch(f.ops),headers=await login(app),r=await run(app,headers),n=await note(app,headers,r.id),a=await analysis(app,headers,r.id,n.id);f.fail();
 const post=await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/operations`,headers,payload:a.input});expect(post.statusCode).toBe(200);expect(post.json()).toMatchObject({status:'unknown',errorCode:'EXTERNAL_OUTCOME_UNKNOWN',dispatchCount:1});
 const read=await app.inject({url:`/v2/runs/${r.id}/memory/operations/${a.action.operationId}`,headers});expect(read.statusCode).toBe(200);expect(read.json().status).toBe('unknown');
 expect((await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/operations`,headers,payload:a.input})).json().status).toBe('unknown');expect(f.calls).toHaveLength(1);
});
it('filters foreign namespace metadata and rejects cursors from another owned run before SDK access',async()=>{
 const f=sdkFixture(),app=await launch(f.ops),headers=await login(app),r=await run(app,headers),other=await run(app,headers),own=`dfm:v2:${r.userId}:${r.id}:case`;f.list([own,'dfm:v2:foreign:other:case',`${own}:candidates:secret`]);
 const page=await app.inject({url:`/v2/runs/${r.id}/memory/namespaces`,headers});expect(page.statusCode).toBe(200);expect(page.json().namespaces.map((n:any)=>n.name)).toEqual([own]);const before=f.calls.length;
 const denied=await app.inject({url:`/v2/runs/${other.id}/memory/namespaces?cursor=${encodeURIComponent(page.json().nextCursor)}`,headers});expect(denied.statusCode).toBe(400);expect(denied.json().error).toBe('DISCOVERY_CURSOR_SCOPE_MISMATCH');expect(f.calls).toHaveLength(before);
 const forged=await app.inject({url:`/v2/runs/${r.id}/memory/namespaces?cursor=forged`,headers});expect(forged.statusCode).toBe(400);expect(f.calls).toHaveLength(before);
});
it('local deployment without operation SDK explicitly returns unavailable and never fabricates a restore',async()=>{
 const app=await launch(),headers=await login(app),r=await run(app,headers);const response=await app.inject({method:'POST',url:`/v2/runs/${r.id}/memory/preview`,headers,payload:{kind:'restore',operationId:randomUUID(),lane:'case',limit:10}});expect(response.statusCode).toBe(503);expect(response.json().error).toBe('MEMORY_OPERATIONS_UNAVAILABLE');expect(response.json().result).toBeUndefined();
});

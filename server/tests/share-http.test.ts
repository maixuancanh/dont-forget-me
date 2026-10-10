import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { schema } from '../src/config.js';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test'; assertTestDatabase(database);
const namespace = 'share_http_' + randomUUID().replaceAll('-', ''), admin = new pg.Pool({ connectionString: database }), pool = new pg.Pool({ connectionString: database, max: 1, connectionTimeoutMillis: 1500, options: `-c search_path=${namespace},public` }), repo = new PostgresRepository(pool);
let app: Awaited<ReturnType<typeof createApp>>['app'], directory: string, headers: Record<string,string>, foreign: Record<string,string>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(),'dfm-share-http-')); await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate();
  app = (await createApp(schema.parse({ SESSION_SECRET:'fixture-share-session-secret-only-32', DATA_FILE:join(directory,'auth.json') }), undefined, undefined, undefined, { repository:repo, startWorker:false, memoryBackend:{semantic:async()=>[]} })).app;
  async function login(name:string) { const response=await app.inject({method:'POST',url:'/v1/session',payload:{name,accessCode:`fixture-${name}-share-access-code`}});expect(response.statusCode).toBe(200);return {authorization:`Bearer ${response.json().accessToken ?? response.json().token}`}; }
  headers=await login('alice');foreign=await login('bob');
});
afterAll(async () => { await app?.close();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true}); });
async function fixture() {
  const response=await app.inject({method:'POST',url:'/v2/runs',headers,payload:{}});expect(response.statusCode).toBe(200);const run=response.json().run;
  const ids=[randomUUID(),randomUUID()];
  for (const [index,id] of ids.entries()) {
    const source:MemoryRecordV2={schemaVersion:2,id,eventId:randomUUID(),userId:run.userId,runId:run.id,sessionId:'SECRET_SESSION',sequence:index+1,storyVersion:run.storyVersion,beatId:run.checkpoint.beatId,inGameDay:1,createdAt:'2026-10-09T00:00:00Z',actor:'binh',kind:'utterance',epistemicStatus:'said',text:index===0?'UNSELECTED_ANCESTOR':'<script>alert("x")</script> Selected quote',sourceIds:index===1?[ids[0]]:[],originIds:[id],recipients:['player'],entityIds:[],propositionIds:[]};
    await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,source.eventId,run.userId,index+1,'fixture_source',{},'fixture']);
    const c=await pool.connect();try{const serialized=serializeMemoryRecord(source);await repo.insertRecord(c,source,serialized.bytes,serialized.contentHash);}finally{c.release();}
  }
  return {run,ids};
}
async function create(f:Awaited<ReturnType<typeof fixture>>) {
  const selection={selectedIds:[f.ids[1]],includePrivate:false,expiresAt:new Date(Date.now()+3600000).toISOString()};
  const preview=await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares/preview`,headers,payload:selection});expect(preview.statusCode).toBe(200);
  const payload={...selection,confirmationHash:preview.json().confirmationHash,publicSharingConfirmed:true,clientActionId:randomUUID()};
  const response=await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares`,headers,payload});expect(response.statusCode).toBe(200);return {share:response.json(),payload};
}
it('mounts authenticated preview/create/list/revoke and sanitized public viewer with maxPool1',async()=>{
  const f=await fixture(),{share,payload}=await create(f);
  const publicResponse=await app.inject({url:`/api/case-shares/${share.token}`});expect(publicResponse.statusCode).toBe(200);expect(publicResponse.headers['cache-control']).toBe('no-store');expect(publicResponse.headers['referrer-policy']).toBe('no-referrer');
  expect(publicResponse.json().snapshot.sources[0].quote).toContain('<script>');for(const secret of [f.run.userId,f.run.id,'SECRET_SESSION','UNSELECTED_ANCESTOR'])expect(publicResponse.body).not.toContain(secret);
  const replay=await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares`,headers,payload});expect(replay.json()).toMatchObject({id:share.id,replayed:true,token:null});
  const list=await app.inject({url:`/v2/runs/${f.run.id}/shares`,headers});expect(list.statusCode).toBe(200);expect(list.json().shares).toHaveLength(1);expect(list.body).not.toContain(share.token);
  expect((await app.inject({url:`/v2/runs/${f.run.id}/shares`,headers:foreign})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares/${share.id}/revoke`,headers:foreign,payload:{}})).statusCode).toBe(403);
  const revoke=await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares/${share.id}/revoke`,headers,payload:{}});expect(revoke.json().revoked).toBe(true);expect(revoke.json()).not.toHaveProperty('snapshot');
  expect((await app.inject({url:`/api/case-shares/${share.token}`})).statusCode).toBe(404);
  for(const file of ['shared.html','shared.css','shared.js','manage.html','manage.css','manage.js']){const page=await app.inject({url:'/case/'+file});expect(page.statusCode).toBe(200);expect(page.headers['content-security-policy']).toContain("default-src 'none'");if(file.endsWith('.js'))expect(page.body).not.toContain('innerHTML');}
});
it('denies tombstoned canonical source and derived descendants in preview and existing public snapshots',async()=>{
  const f=await fixture(),{share}=await create(f),operationId=randomUUID();
  await pool.query("INSERT INTO memory_lifecycle_operations(id,user_id,run_id,kind,preview,confirmation_hash,status) VALUES($1,$2,$3,'delete',$4,'fixture','confirmed')",[operationId,f.run.userId,f.run.id,{}]);
  await pool.query('INSERT INTO memory_tombstones(user_id,run_id,record_id,operation_id) VALUES($1,$2,$3,$4)',[f.run.userId,f.run.id,f.ids[0],operationId]);
  const blocked=await app.inject({method:'POST',url:`/v2/runs/${f.run.id}/shares/preview`,headers,payload:{selectedIds:[f.ids[1]],includePrivate:false,expiresAt:new Date(Date.now()+3600000).toISOString()}});expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
  // A canonical hash tombstone gates a previously created link even if a revoke update has not run yet.
  await pool.query('INSERT INTO memory_tombstones(user_id,run_id,record_id,operation_id) VALUES($1,$2,$3,$4)',[f.run.userId,f.run.id,f.ids[1],operationId]);
  expect((await app.inject({url:`/api/case-shares/${share.token}`})).statusCode).toBe(404);
});


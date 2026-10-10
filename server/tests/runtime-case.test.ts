import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { schema } from '../src/config.js';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { beats, propositions, STORY_VERSION } from '../src/story/canon.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace = 'runtime_case_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: database });
const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${namespace},public` });
const repo = new PostgresRepository(pool);
let directory: string, app: FastifyInstance, headers: Record<string, string>, foreign: Record<string, string>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dfm-case-')); await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate();
  app = (await createApp(schema.parse({ SESSION_SECRET: 'fixture-runtime-case-secret-only-32', DATA_FILE: join(directory, 'auth.json') }), undefined, undefined, undefined, { repository: repo, startWorker: false, memoryBackend: { semantic: async () => [] } })).app;
  const login = async (name: string) => { const response = await app.inject({ method: 'POST', url: '/v1/session', payload: { name, accessCode: `fixture-${name}-access-code` } }); expect(response.statusCode).toBe(200); return { authorization: `Bearer ${response.json().accessToken ?? response.json().token}` }; };
  headers = await login('alice'); foreign = await login('bob');
});
afterAll(async () => { await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
async function fixture(verified = true, shown = true) {
  const response = await app.inject({ method: 'POST', url: '/v2/runs', headers, payload: {} }); expect(response.statusCode).toBe(200);
  const run = response.json().run;
  await pool.query("UPDATE runs SET checkpoint=jsonb_set(checkpoint,'{day}','6'),event_sequence=6 WHERE id=$1", [run.id]);
  const ids: string[] = [], records: MemoryRecordV2[] = [];
  const propositionIds = ['p.ledger', 'p.Day6_1_Carlo.11', 'p.Day6_2_Mario.0', 'p.Day6_3_Jomar.10', 'p.Day2_1_Junjun.4'];
  for (const [index, propositionId] of propositionIds.entries()) {
    const proposition = propositions.find(item => item.id === propositionId)!, beat = beats.find(item => item.propositionIds.includes(propositionId))!;
    const id = randomUUID(), eventId = randomUUID(); ids.push(id);
    const record: MemoryRecordV2 = { schemaVersion: 2, id, eventId, userId: run.userId, runId: run.id, sessionId: 'fixture', sequence: index + 1, storyVersion: STORY_VERSION, beatId: beat.beatId, inGameDay: proposition.minimumDay, createdAt: '2026-10-09T00:00:00Z', actor: proposition.owner as MemoryRecordV2['actor'], kind: proposition.epistemicStatus === 'observed' ? 'observation' : 'utterance', epistemicStatus: proposition.epistemicStatus as MemoryRecordV2['epistemicStatus'], text: proposition.meaning, sourceIds: [], originIds: [id], recipients: ['player'], entityIds: [], propositionIds: [propositionId] }; records.push(record);
    await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [run.id, eventId, run.userId, index + 1, 'fixture_canonical_source', {}, 'fixture']);
    const c = await pool.connect(); try { const serialized = serializeMemoryRecord(record); await repo.insertRecord(c, record, serialized.bytes, serialized.contentHash); } finally { c.release(); }
    if (verified) {
      const bindingId = `runtime:local:${run.userId}`, ns = `dfm:v2:${run.userId}:${run.id}:case`, hash = serializeMemoryRecord(record).contentHash;
      await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)', [id, bindingId, ns, 'retrievable', hash, { recordId: id, accountBindingId: bindingId, namespace: ns, network: 'local', state: 'retrievable', blobId: `local:${id}`, contentHash: hash, verifiedAt: '2026-10-09T00:00:00Z', lastRecallAt: '2026-10-09T00:00:00Z' }]);
    }
  }
  if (shown) await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,6,$4,$5,$6)', [run.id, randomUUID(), run.userId, 'journal_action', { result: { promiseEvents: [{ userId: run.userId, runId: run.id, id: randomUUID(), sequence: 6, sourceIds: ids, kind: 'disclose', recipient: 'phuc', recordIds: ids }] } }, 'fixture']);
  return { run, ids, records };
}
const submit = (f: Awaited<ReturnType<typeof fixture>>, extra: object = {}) => app.inject({ method: 'POST', url: `/v2/runs/${f.run.id}/case`, headers, payload: { recordIds: f.ids, expectedRevision: 0, clientActionId: randomUUID(), ...extra } });
it('guards owners, unknown sources and case review day', async () => {
  const f = await fixture();
  expect((await app.inject({ method: 'POST', url: `/v2/runs/${f.run.id}/compare`, headers: foreign, payload: { recordIds: [f.ids[0], f.ids[4]] } })).statusCode).toBe(403);
  expect((await submit(f, { recordIds: ['unknown'] })).statusCode).toBe(403);
  await pool.query("UPDATE runs SET checkpoint=jsonb_set(checkpoint,'{day}','5') WHERE id=$1", [f.run.id]);
  const early = await submit(f, { recordIds: [] }); expect(early.statusCode).toBe(409); expect(early.json().error).toBe('CASE_REVIEW_NOT_OPEN');
});
it('returns pending without persisting an ending or outbox', async () => {
  const f = await fixture(false), response = await submit(f); expect(response.statusCode).toBe(200); expect(response.json().outcome).toBe('pending');
  expect((await repo.getRun(f.run.userId, f.run.id)).revision).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE run_id=$1', [f.run.id])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM memory_records WHERE run_id=$1 AND kind='outcome'", [f.run.id])).rows[0].n).toBe(0);
});
it('requires disclosure to Phuc and persists unresolved continuation', async () => {
  const f = await fixture(true, false), response = await submit(f); expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ outcome: 'unresolved', canContinue: true, missing: ['Report each selected source to Phuc'] });
});
it('commits authoritative case state by CAS and replays the outcome/outbox once', async () => {
  const f = await fixture(), clientActionId = randomUUID();
  const first = await submit(f, { clientActionId }); expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ outcome: 'resolved', runRevision: 1 });
  const replay = await submit(f, { clientActionId }); expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ replayed: true, outcome: 'resolved' });
  expect(replay.json().record.id).toBe(first.json().record.id);
  const stale = await submit(f); expect(stale.statusCode).toBe(409);
  const summary = await app.inject({ url: `/v2/runs/${f.run.id}/summary`, headers }); expect(summary.json().outcome).toBe('resolved');
  const counts = await pool.query("SELECT (SELECT count(*) FROM outbox_jobs WHERE run_id=$1)::int jobs,(SELECT count(*) FROM memory_records WHERE run_id=$1 AND kind='outcome')::int outcomes", [f.run.id]); expect(counts.rows[0]).toEqual({ jobs: 1, outcomes: 1 });
});
it('compares precisely two canonical receipt-proven sources without canned NPC dialogue', async () => {
  const f = await fixture(), response = await app.inject({ method: 'POST', url: `/v2/runs/${f.run.id}/compare`, headers, payload: { recordIds: [f.ids[4], f.ids[0]] } });
  expect(response.statusCode).toBe(200); expect(response.json().matchedRuleIds).toContain('ledger_confirms_duplicate'); expect(response.json()).not.toHaveProperty('npcResponse');
  const pending = await fixture(false), noProof = await app.inject({ method: 'POST', url: `/v2/runs/${pending.run.id}/compare`, headers, payload: { recordIds: [pending.ids[4], pending.ids[0]] } }); expect(noProof.json().state).toBe('pending');
});

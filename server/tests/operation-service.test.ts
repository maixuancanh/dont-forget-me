import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
import { MemoryOperations, type OperationsSdk } from '../src/memory/operations.js';
import { MemoryOperationService, type OperationAction } from '../src/memory/operation-service.js';
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace = 'operation_service_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: database });
const pool = new pg.Pool({ connectionString: database, max: 1, options: `-c search_path=${namespace},public` });
const repo = new PostgresRepository(pool);
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate(); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); });
async function fixture(deadlineMs = 35000) {
  const userId = await repo.upsertUser('fixture', randomUUID()), run = await repo.createRun({ userId, storyVersion: 'v', initialCheckpoint: { day: 1, beatId: 'b', sceneId: 's', stepIndex: 0, scheduleIndex: 0, phase: 'dialogue' } });
  const bindingId = randomUUID(), owner = 'fixture-owner';
  await pool.query('INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,$3,$4,$5)', [bindingId, userId, 'local', 'local', owner]);
  const record: MemoryRecordV2 = { schemaVersion: 2, id: randomUUID(), eventId: randomUUID(), userId, runId: run.id, sessionId: 's', sequence: 1, storyVersion: 'v', beatId: 'b', inGameDay: 1, createdAt: '2026-10-09T00:00:00Z', actor: 'player', kind: 'hypothesis', text: 'My own untrusted note', epistemicStatus: 'hypothesized', sourceIds: [], originIds: [], recipients: ['player'], entityIds: [], propositionIds: [] };
  await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,1,$4,$5,$6)', [run.id, record.eventId, userId, 'journal_action', {}, 'fixture']);
  const c = await pool.connect(); try { const serialized = serializeMemoryRecord(record); await repo.insertRecord(c, record, serialized.bytes, serialized.contentHash); } finally { c.release(); }
  await pool.query('UPDATE runs SET event_sequence=1 WHERE id=$1', [run.id]);
  let calls = 0, fail = false, block: Promise<void> | undefined;
  const sdk: OperationsSdk = {
    analyzeAndWait: async (_text, options) => { calls++; await block; if (fail) throw new Error('timeout after upload'); const namespace = typeof options === 'string' ? options : options?.namespace ?? ''; return { owner, facts: [{ id: 'job', text: 'Candidate only' }], results: [{ id: 'job', blob_id: 'blob', namespace, status: 'done' }], total: 1, succeeded: 1, failed: 0 }; },
    restore: async namespace => { calls++; await block; return { owner, namespace, restored: 0, skipped: 0, failed: 0, total: 0, truncated: false }; },
    listNamespaces: async () => ({ namespaces: [], has_more: false, next_cursor: null, snapshot_version: 1 }),
  };
  const ops = new MemoryOperations(sdk, 'fixture-operation-cursor-secret-only-32');
  const binding = async () => ({ accountBindingId: bindingId, owner, network: 'local' as const });
  const service = new MemoryOperationService(repo, ops, binding, deadlineMs); await service.migrate();
  const action: OperationAction = { kind: 'analyze', operationId: randomUUID(), rawInputRecordId: record.id };
  const preview = await service.preview(userId, run.id, action);
  const commit = { action, expectedRevision: preview.scope.revision, clientActionId: randomUUID(), confirmed: true as const, confirmationHash: preview.confirmationHash };
  return { userId, runId: run.id, service, action, commit, bindingId, record, calls: () => calls, fail: () => { fail = true; }, block: (wait: Promise<void>) => { block = wait; }, restart: () => new MemoryOperationService(repo, ops, binding, deadlineMs) };
}
it('bounds a never-resolving SDK call and records unknown without redispatch after restart', async () => {
  const f = await fixture(25); f.block(new Promise<void>(() => {}));
  await f.service.commit(f.userId, f.runId, f.commit);
  expect(await f.service.dispatch(f.userId, f.runId, f.action.operationId)).toMatchObject({ status: 'unknown', errorCode: 'EXTERNAL_OUTCOME_UNKNOWN', dispatchCount: 1 });
  expect((await f.restart().dispatch(f.userId, f.runId, f.action.operationId)).status).toBe('unknown'); expect(f.calls()).toBe(1);
}, 1000);
it('validates server dispatch deadline bounds before starting any work', () => {
  const binding = async () => ({accountBindingId:'fixture',owner:'fixture',network:'local' as const});
  for (const deadline of [0,-1,1.5,120001,NaN,Infinity]) expect(() => new MemoryOperationService(repo, {} as MemoryOperations, binding, deadline)).toThrow('INVALID_OPERATION_DEADLINE');
  expect(() => new MemoryOperationService(repo, {} as MemoryOperations, binding)).not.toThrow();
});
it('never overwrites unknown or dispatches again when the timed-out restore eventually finishes', async () => {
  const f = await fixture(25); let release!: () => void; f.block(new Promise<void>(resolve => { release = resolve; }));
  const action: OperationAction = {kind:'restore',operationId:randomUUID(),lane:'case',limit:10};
  const preview = await f.service.preview(f.userId, f.runId, action);
  await f.service.commit(f.userId, f.runId, {...f.commit,action,confirmationHash:preview.confirmationHash});
  expect((await f.service.dispatch(f.userId, f.runId, action.operationId)).status).toBe('unknown');
  release(); await new Promise<void>(resolve => setTimeout(resolve, 10));
  expect(await f.service.read(f.userId, f.runId, action.operationId)).toMatchObject({status:'unknown',dispatchCount:1,result:null});
  expect((await f.restart().dispatch(f.userId, f.runId, action.operationId)).status).toBe('unknown'); expect(f.calls()).toBe(1);
}, 1000);
it('durably commits exact opt-in CAS once, persists real SDK candidate receipts and replays dispatch', async () => {
  const f = await fixture();
  const committed = await f.service.commit(f.userId, f.runId, f.commit); expect(committed.run.revision).toBe(1); expect(f.calls()).toBe(0);
  expect((await f.service.commit(f.userId, f.runId, f.commit)).replayed).toBe(true);
  const result = await f.service.dispatch(f.userId, f.runId, f.action.operationId);
  expect(result).toMatchObject({ status: 'completed', dispatchCount: 1, result: { automaticallyStored: true, candidates: [{ reviewState: 'unreviewed', canonicalEvidence: false }] } });
  expect((await f.restart().dispatch(f.userId, f.runId, f.action.operationId)).status).toBe('completed'); expect(f.calls()).toBe(1);
  expect((await pool.query('SELECT count(*)::int n FROM memory_operations WHERE run_id=$1', [f.runId])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT count(*)::int n FROM memory_records WHERE run_id=$1', [f.runId])).rows[0].n).toBe(1);
});
it('claims parallel dispatch once without holding a PG connection during external SDK calls', async () => {
  const f = await fixture(); await f.service.commit(f.userId, f.runId, f.commit);
  await Promise.all([f.service.dispatch(f.userId, f.runId, f.action.operationId), f.restart().dispatch(f.userId, f.runId, f.action.operationId)]);
  expect(f.calls()).toBe(1); expect((await f.service.read(f.userId, f.runId, f.action.operationId)).dispatchCount).toBe(1);
});
it('records unknown external outcomes and never redispatches after restart', async () => {
  const f = await fixture(); await f.service.commit(f.userId, f.runId, f.commit); f.fail();
  expect((await f.service.dispatch(f.userId, f.runId, f.action.operationId))).toMatchObject({ status: 'unknown', errorCode: 'EXTERNAL_OUTCOME_UNKNOWN' });
  expect((await f.restart().dispatch(f.userId, f.runId, f.action.operationId)).status).toBe('unknown'); expect(f.calls()).toBe(1);
});
it('fails closed for a crash after durable dispatch claim with no result', async () => {
  const f = await fixture(); await f.service.commit(f.userId, f.runId, f.commit);
  await pool.query("UPDATE memory_operations SET status='dispatched',dispatch_count=1 WHERE run_id=$1", [f.runId]);
  expect((await f.restart().dispatch(f.userId, f.runId, f.action.operationId)).status).toBe('dispatched'); expect(f.calls()).toBe(0);
});
it('rejects foreign note/owner, stale consent, operation ID reuse and inactive binding', async () => {
  const f = await fixture(), foreign = await fixture();
  await expect(f.service.preview(f.userId, f.runId, { ...f.action, rawInputRecordId: foreign.record.id })).rejects.toMatchObject({ code: 'ANALYSIS_NOTE_UNAVAILABLE' });
  await expect(f.service.read(foreign.userId, f.runId, f.action.operationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(f.service.commit(f.userId, f.runId, { ...f.commit, confirmationHash: 'bad' })).rejects.toMatchObject({ code: 'OPERATION_CONSENT_STALE' });
  await f.service.commit(f.userId, f.runId, f.commit);
  const current = await f.service.preview(f.userId, f.runId, f.action);
  await expect(f.service.commit(f.userId, f.runId, { ...f.commit, expectedRevision: 1, clientActionId: randomUUID(), confirmationHash: current.confirmationHash })).rejects.toMatchObject({ code: 'OPERATION_ID_REUSED' });
  await pool.query("UPDATE account_bindings SET status='revoked' WHERE id=$1", [f.bindingId]);
  await expect(f.service.dispatch(f.userId, f.runId, f.action.operationId)).rejects.toMatchObject({ code: 'OPERATION_BINDING_UNAVAILABLE' }); expect(f.calls()).toBe(0);
});
it('queues an explicit restore request server-side and preserves read-only unproven SDK results', async () => {
  const f = await fixture(), action: OperationAction = { kind: 'restore', operationId: randomUUID(), lane: 'case', limit: 20 }, preview = await f.service.preview(f.userId, f.runId, action);
  await f.service.commit(f.userId, f.runId, { action, expectedRevision: 0, clientActionId: randomUUID(), confirmed: true, confirmationHash: preview.confirmationHash });
  expect((await f.service.dispatch(f.userId, f.runId, action.operationId))).toMatchObject({ status: 'completed', result: { completeness: 'unproven', projectionReadOnly: true, restored: 0 } });
  expect((await f.service.discover(f.userId, f.runId)).manifestValidationRequired).toBe(true);
});
it('refuses dispatch when the binding account object changes under the same binding ID', async () => {
  const f = await fixture(); await f.service.commit(f.userId, f.runId, f.commit);
  await pool.query('UPDATE account_bindings SET account_id=$2 WHERE id=$1', [f.bindingId, 'different-account-object']);
  await expect(f.service.dispatch(f.userId, f.runId, f.action.operationId)).rejects.toMatchObject({ code: 'OPERATION_SCOPE_CHANGED' });
  expect(f.calls()).toBe(0); expect((await f.service.read(f.userId, f.runId, f.action.operationId)).dispatchCount).toBe(0);
});

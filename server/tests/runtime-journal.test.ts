import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
import { ownedJournal, ownedEvidenceSource, ownedEvidenceGraph } from '../src/evidence/runtime-journal.js';

const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace = 'runtime_journal_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: database });
const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${namespace},public` });
const repo = new PostgresRepository(pool);
let userId: string, runId: string;
const fixture = (id: string, sequence: number, kind: MemoryRecordV2['kind'] = 'utterance'): MemoryRecordV2 => ({ schemaVersion: 2, id, eventId: `e-${id}`, userId, runId, sessionId: 's', sequence, storyVersion: 'v', beatId: 'b', inGameDay: 2, createdAt: '2026-10-09T00:00:00Z', actor: 'binh', kind, text: `blue ${id}`, epistemicStatus: kind === 'observation' ? 'observed' : 'said', sourceIds: [], originIds: [id], recipients: ['player'], entityIds: [], propositionIds: [] });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate();
  userId = await repo.upsertUser('fixture', randomUUID());
  const run = await repo.createRun({ userId, storyVersion: 'v', initialCheckpoint: { beatId: 'b', day: 2, sceneId: 'scene', stepIndex: 0, scheduleIndex: 0, phase: 'dialogue' } }); runId = run.id;
  const client = await pool.connect();
  try {
    for (const [id, sequence, status] of [['ack', 1, 'acknowledged'], ['pending', 2, 'committed'], ['commerce', 3, 'gameplay']] as const) {
      const record = fixture(id, sequence, status === 'gameplay' ? 'observation' : 'utterance'), serialized = serializeMemoryRecord(record);
      await client.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, record.eventId, userId, sequence, status === 'gameplay' ? 'commerce_payment' : 'turn_committed', {}, 'fixture']);
      await repo.insertRecord(client, record, serialized.bytes, serialized.contentHash);
      if (status !== 'gameplay') await client.query('INSERT INTO turns(id,user_id,run_id,client_turn_id,expected_revision,committed_revision,request_hash,status,response,event_id) VALUES($1,$2,$3,$1,0,1,$4,$5,$6,$7)', [`turn-${id}`, userId, runId, 'fixture', status, {}, record.eventId]);
    }
    await client.query('INSERT INTO evidence_edges(id,run_id,source_id,target_id,kind,cause_event_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7)', ['relation', runId, 'commerce', 'ack', 'supports', 'e-commerce', { sourceIds: ['commerce', 'ack'], cause: 'committed payment observation' }]);
  } finally { client.release(); }
});
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); });

it('includes committed gameplay and acknowledged speech while suppressing pending speech', async () => {
  const journal = await ownedJournal(repo, userId, runId);
  expect(journal.records.map(record => record.id)).toEqual(['ack', 'commerce']);
  expect(journal.records[1]).toMatchObject({ quote: 'blue commerce', speaker: 'binh', day: 2, type: 'observation', claimStatus: 'observed', status: 'queued' });
});
it('enforces owned run isolation for journal, exact source and graph', async () => {
  for (const call of [() => ownedJournal(repo, 'foreign', runId), () => ownedEvidenceSource(repo, 'foreign', runId, 'ack'), () => ownedEvidenceGraph(repo, 'foreign', runId)]) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('pages and filters current day, UTC date and kind', async () => {
  const first = await ownedJournal(repo, userId, runId, { limit: 1, currentDay: true, date: '2026-10-09', query: 'blue' });
  expect(first.nextCursor).toBe('ack'); expect(first.total).toBe(2);
  expect((await ownedJournal(repo, userId, runId, { cursor: first.nextCursor, limit: 1 })).records[0].id).toBe('commerce');
  expect((await ownedJournal(repo, userId, runId, { kinds: ['observation'] })).records).toHaveLength(1);
  expect((await ownedJournal(repo, userId, runId, { day: 1 })).total).toBe(0);
});
it('serves exact canonical local bytes with explicit proof boundary and pending unavailable', async () => {
  const source = await ownedEvidenceSource(repo, userId, runId, 'ack');
  expect(source).toMatchObject({ availability: 'available', provenance: 'local_ledger', newRemoteRecall: false, original: { text: 'blue ack' } });
  expect(JSON.parse(source.canonicalBytes!)).toEqual(source.original);
  expect((await ownedEvidenceSource(repo, userId, runId, 'pending')).availability).toBe('unavailable');
});
it('returns persisted typed edges with explicit selection', async () => {
  expect((await ownedEvidenceGraph(repo, userId, runId)).edges[0]).toMatchObject({ type: 'supports', cause: 'committed payment observation', sourceIds: ['commerce', 'ack'] });
  expect((await ownedEvidenceGraph(repo, userId, runId, ['commerce'])).edges).toEqual([]);
});

import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
import { GameplayService, type JournalAction } from '../src/gameplay/service.js';
import { projectPromises } from '../src/gameplay/promises.js';
import { ownedEvidenceSource, ownedEvidenceGraph } from '../src/evidence/runtime-journal.js';
import { progressionBeats } from '../src/runs/service.js';
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace = 'gameplay_pg_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: database });
const pool = new pg.Pool({ connectionString: database, max: 1, options: `-c search_path=${namespace},public` });
const repo = new PostgresRepository(pool);
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate(); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); });
async function fixture() {
  const userId = await repo.upsertUser('fixture', randomUUID());
  const index = progressionBeats.findIndex(beat => beat.npcId === 'binh');
  const run = await repo.createRun({ userId, storyVersion: 'v', initialCheckpoint: { day: 6, beatId: 'b', sceneId: 'scene', stepIndex: 0, scheduleIndex: index, phase: 'dialogue' } });
  const binding = { id: randomUUID(), namespace: randomUUID(), network: 'local' as const };
  await pool.query('INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,$3,$4,$5)', [binding.id, userId, 'local', 'local', randomUUID()]);
  const turnId = randomUUID(), recordId = randomUUID(), eventId = randomUUID();
  const record: MemoryRecordV2 = { schemaVersion: 2, id: recordId, eventId, userId, runId: run.id, sessionId: 's', sequence: 1, storyVersion: 'v', beatId: 'b', inGameDay: 1, createdAt: '2026-10-09T00:00:00Z', actor: 'binh', kind: 'utterance', text: 'I saw a blue truck', epistemicStatus: 'said', sourceIds: [], originIds: [recordId], recipients: ['player', 'binh'], entityIds: [], propositionIds: [], linkedTurnId: turnId };
  const proposal = { id: 'offer', action: { kind: 'offer_commitment', commitment: { type: 'promise', proposer: 'binh', beneficiary: 'binh', topicEntityIds: [], condition: 'keep_confidential', targetIds: [recordId], forbiddenRecipients: ['hanh'], permittedRecipients: [], sourceIds: [recordId] } } };
  await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,1,$4,$5,$6)', [run.id, eventId, userId, 'turn_committed', {}, 'fixture']);
  const c = await pool.connect(); try { const s = serializeMemoryRecord(record); await repo.insertRecord(c, record, s.bytes, s.contentHash); } finally { c.release(); }
  await pool.query('INSERT INTO turns(id,user_id,run_id,client_turn_id,expected_revision,committed_revision,request_hash,status,response,event_id) VALUES($1,$2,$3,$1,0,1,$4,$5,$6,$7)', [turnId, userId, run.id, 'fixture', 'acknowledged', { proposals: [proposal] }, eventId]);
  await pool.query('UPDATE runs SET event_sequence=1 WHERE id=$1', [run.id]);
  const service = new GameplayService(repo, async () => binding);
  const commit = async (action: JournalAction, clientActionId = randomUUID()) => {
    const preview = await service.preview(userId, run.id, action);
    return service.commit(userId, 's', run.id, { expectedRevision: preview.revision, clientActionId, consentHash: preview.consentHash, action });
  };
  return { userId, runId: run.id, binding, record, turnId, service, commit };
}
it('atomically saves note, domain event, outbox and graph and replays once on max-one pool', async () => {
  const f = await fixture(), action: JournalAction = { kind: 'note', text: 'My hypothesis', recordIds: [f.record.id] };
  const preview = await f.service.preview(f.userId, f.runId, action), input = { expectedRevision: preview.revision, clientActionId: randomUUID(), consentHash: preview.consentHash, action };
  const saved = await f.service.commit(f.userId, 's', f.runId, input), replay = await f.service.commit(f.userId, 's', f.runId, input);
  expect(replay.replayed).toBe(true); expect(replay.result.record.id).toBe(saved.result.record.id);
  const counts = await pool.query('SELECT (SELECT count(*) FROM outbox_jobs WHERE run_id=$1)::int AS jobs,(SELECT count(*) FROM evidence_edges WHERE run_id=$1)::int AS edges,(SELECT count(*) FROM domain_events WHERE run_id=$1 AND kind=$2)::int AS events', [f.runId, 'journal_action']);
  expect(counts.rows[0]).toEqual({ jobs: 1, edges: 1, events: 1 });
  expect((await ownedEvidenceGraph(repo, f.userId, f.runId)).edges[0].type).toBe('derived_from');
});
it('denies NPC quote edits but corrects own hypothesis while retaining both originals', async () => {
  const f = await fixture();
  await expect(f.service.preview(f.userId, f.runId, { kind: 'correct', recordId: f.record.id, text: 'Replace quote' })).rejects.toMatchObject({ code: 'ORIGINAL_QUOTE_READ_ONLY' });
  const note = await f.commit({ kind: 'note', text: 'Maybe blue', recordIds: [f.record.id] });
  const correction = await f.commit({ kind: 'correct', recordId: note.result.record.id, text: 'Maybe red' });
  expect(correction.result.record.supersedesId).toBe(note.result.record.id);
  expect((await ownedEvidenceSource(repo, f.userId, f.runId, note.result.record.id))).toMatchObject({ retracted: true, original: { text: 'Maybe blue' } });
  expect((await ownedEvidenceSource(repo, f.userId, f.runId, f.record.id)).original?.text).toBe('I saw a blue truck');
});
it('rejects duplicate aliases and cross-run sources without partial writes', async () => {
  const f = await fixture(), other = await fixture();
  await f.commit({ kind: 'alias', text: 'Blue truck', recordIds: [f.record.id] });
  await expect(f.service.preview(f.userId, f.runId, { kind: 'alias', text: 'BLUE TRUCK', recordIds: [f.record.id] })).rejects.toMatchObject({ code: 'ALIAS_DUPLICATE_OR_TARGET_INVALID' });
  await expect(f.service.preview(f.userId, f.runId, { kind: 'alias', text: 'Foreign', recordIds: [other.record.id] })).rejects.toMatchObject({ code: 'SOURCE_NOT_AVAILABLE' });
  expect((await pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE run_id=$1', [f.runId])).rows[0].n).toBe(1);
});
it('rejects stale consent after another mutation even with updated expected revision', async () => {
  const f = await fixture(), action: JournalAction = { kind: 'note', text: 'stale', recordIds: [f.record.id] };
  const stale = await f.service.preview(f.userId, f.runId, action);
  await f.commit({ kind: 'note', text: 'concurrent edit', recordIds: [] });
  await expect(f.service.commit(f.userId, 's', f.runId, { expectedRevision: stale.revision + 1, clientActionId: randomUUID(), consentHash: stale.consentHash, action })).rejects.toMatchObject({ code: 'CONSENT_STALE' });
  expect((await pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE run_id=$1', [f.runId])).rows[0].n).toBe(1);
});
it('rejects wrong binding and wrong hash receipts for a known recipient', async () => {
  const f = await fixture(), wrongBinding = randomUUID();
  await pool.query('INSERT INTO account_bindings(id,user_id,network,mode,account_id) VALUES($1,$2,$3,$4,$5)', [wrongBinding, f.userId, 'local', 'local', randomUUID()]);
  const hash = serializeMemoryRecord(f.record).contentHash;
  const receipt = (bindingId: string, contentHash: string) => ({ recordId: f.record.id, accountBindingId: bindingId, namespace: f.binding.namespace, network: 'local', state: 'retrievable', contentHash, verifiedAt: '2026-10-09T00:00:00Z', lastRecallAt: '2026-10-09T00:00:00Z', blobId: 'fixture' });
  await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)', [f.record.id, wrongBinding, f.binding.namespace, 'retrievable', hash, receipt(wrongBinding, hash)]);
  const action: JournalAction = { kind: 'share', recipient: 'binh', recordIds: [f.record.id] };
  await expect(f.service.preview(f.userId, f.runId, action)).rejects.toMatchObject({ code: 'MEMORY_NOT_CONFIRMED' });
  await pool.query('INSERT INTO memory_receipts(record_id,account_binding_id,namespace,state,content_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)', [f.record.id, f.binding.id, f.binding.namespace, 'retrievable', 'wrong-hash', receipt(f.binding.id, 'wrong-hash')]);
  await expect(f.service.preview(f.userId, f.runId, action)).rejects.toMatchObject({ code: 'MEMORY_NOT_CONFIRMED' });
});
it('accepts an acknowledged persisted promise proposal and reprojects JSONB acceptance hashes on replay', async () => {
  const f = await fixture(), action: JournalAction = { kind: 'accept_promise', turnId: f.turnId, proposalId: 'offer' };
  const preview = await f.service.preview(f.userId, f.runId, action), input = { expectedRevision: preview.revision, clientActionId: randomUUID(), consentHash: preview.consentHash, action };
  const saved = await f.service.commit(f.userId, 's', f.runId, input);
  expect(saved.result.record.kind).toBe('promise');
  const project = projectPromises({ userId: f.userId, runId: f.runId }, await f.service.records(f.userId, f.runId), await f.service.events(f.userId, f.runId));
  expect(project.commitments[0].status).toBe('accepted');
  expect((await f.service.commit(f.userId, 's', f.runId, input)).replayed).toBe(true);
  await expect(f.commit(action)).rejects.toMatchObject({ code: 'PROMISE_ALREADY_ACCEPTED' });
});
it('keeps pending proposals non-executable until their display acknowledgement', async () => {
  const f = await fixture(), action: JournalAction = { kind: 'accept_promise', turnId: f.turnId, proposalId: 'offer' };
  await pool.query("UPDATE turns SET status='committed' WHERE id=$1", [f.turnId]);
  await expect(f.service.preview(f.userId, f.runId, action)).rejects.toMatchObject({ code: 'PROMISE_OFFER_UNAVAILABLE' });
  const note: JournalAction = { kind: 'note', text: 'not yet', recordIds: [] };
  const preview = await f.service.preview(f.userId, f.runId, note);
  await expect(f.service.commit(f.userId, 's', f.runId, { expectedRevision: preview.revision, clientActionId: randomUUID(), consentHash: preview.consentHash, action: note })).rejects.toMatchObject({ code: 'TURN_ACK_REQUIRED' });
  expect((await pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE run_id=$1', [f.runId])).rows[0].n).toBe(0);
});

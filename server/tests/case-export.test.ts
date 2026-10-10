import { it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { MemoryRecordV2, MemoryReceipt } from '../src/domain/contracts.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import { previewCaseExport, exportCase, verifyExportReferences, ownedExportPreview, type ExportInput } from '../src/evidence/export.js';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
const record = (id: string, extra: Partial<MemoryRecordV2> = {}): MemoryRecordV2 => ({ schemaVersion: 2, id, eventId: `event-${id}`, userId: 'private-user', runId: 'private-run', sessionId: 'private-session', sequence: 1, storyVersion: 'full-memory-v2', beatId: 'b', inGameDay: 1, createdAt: '2026-10-09T00:00:00Z', actor: 'binh', kind: 'utterance', text: 'An exact original quote', epistemicStatus: 'said', sourceIds: [], originIds: [id], recipients: ['player', 'binh'], entityIds: [], propositionIds: [], ...extra });
function input(extra: Partial<ExportInput> = {}): ExportInput {
  const source = record('root'), receipt: MemoryReceipt = { recordId: source.id, accountBindingId: 'private-binding', namespace: 'private-namespace', network: 'local', state: 'retrievable', contentHash: serializeMemoryRecord(source).contentHash, blobId: 'blob', verifiedAt: '2026-10-09T00:00:00Z', lastRecallAt: '2026-10-09T00:00:00Z' };
  return { scope: { userId: source.userId, runId: source.runId, revision: 1 }, records: [source], receipts: [receipt], selection: { selectedIds: ['root'], includePrivate: false }, ...extra };
}
it('exports exact selected quotes with distinct original/snapshot hashes and redacted identities', () => {
  const evidence = input(), preview = previewCaseExport(evidence), result = exportCase(evidence, preview.confirmationHash);
  expect(result.snapshot.sources[0]).toMatchObject({ quote: 'An exact original quote', sourceCanonicalHash: serializeMemoryRecord(evidence.records[0]).contentHash });
  expect(result.snapshotHash).not.toBe(result.snapshot.sources[0].sourceCanonicalHash);
  for (const secret of ['private-user', 'private-run', 'private-session', 'private-binding', 'private-namespace', 'propositionIds', 'originIds']) expect(result.json).not.toContain(secret);
  expect(result.markdown).toContain('> An exact original quote'); expect(result.snapshot.personalOwnershipProven).toBe(false);
});
it('keeps unselected ancestry and unrelated private chat out of the graph and export', () => {
  const evidence = input({ records: [record('root', { text: 'UNSEEN ROOT' }), record('copy', { sourceIds: ['root'], text: 'Selected quote' }), record('private-chat', { actor: 'player', kind: 'conversation', text: 'UNRELATED SECRET' })], selection: { selectedIds: ['copy'], includePrivate: false } });
  const preview = previewCaseExport(evidence); expect(preview.snapshot.sources[0].selectedSourceReferences).toEqual([]);
  expect(JSON.stringify(preview.snapshot)).not.toContain('UNSEEN ROOT'); expect(JSON.stringify(preview.snapshot)).not.toContain('UNRELATED SECRET');
});
it('requires separate explicit private opt-in and revision-bound confirmation', () => {
  const evidence = input({ records: [record('root', { actor: 'player', kind: 'hypothesis', epistemicStatus: 'hypothesized', text: 'Private note' })] });
  expect(() => previewCaseExport(evidence)).toThrow('OPT_IN_REQUIRED');
  const optedIn = { ...evidence, selection: { ...evidence.selection, includePrivate: true } }, preview = previewCaseExport(optedIn);
  expect(exportCase(optedIn, preview.confirmationHash).snapshot.sources[0].quote).toBe('Private note');
  expect(() => exportCase({ ...optedIn, scope: { ...optedIn.scope, revision: 2 } }, preview.confirmationHash)).toThrow('CONSENT_STALE');
});
it('requires opt-in for canon private witness even when the source is selected', () => {
  const evidence = input({ records: [record('root', { actor: 'duy', propositionIds: ['p.Day5_4_Carlo.13'] })] });
  expect(() => previewCaseExport(evidence)).toThrow('OPT_IN_REQUIRED');
});
it('verifies selected references using original canonical bytes without importing snapshot as canonical', () => {
  const evidence = input(), preview = previewCaseExport(evidence), serialized = serializeMemoryRecord(evidence.records[0]);
  expect(verifyExportReferences(preview.snapshot, preview.snapshotHash, [{ bytes: serialized.bytes, sourceCanonicalHash: serialized.contentHash }])).toMatchObject({ missingSourceCanonicalHashes: [], personalOwnershipProven: false, importedAsCanonicalRecord: false });
  expect(verifyExportReferences(preview.snapshot, preview.snapshotHash, []).missingSourceCanonicalHashes).toEqual([serialized.contentHash]);
  expect(() => verifyExportReferences(preview.snapshot, preview.snapshotHash, [{ bytes: JSON.stringify(preview.snapshot), sourceCanonicalHash: serialized.contentHash }])).toThrow();
  expect(() => verifyExportReferences({ ...preview.snapshot, snapshotId: 'tampered' }, preview.snapshotHash, [])).toThrow('SNAPSHOT_HASH');
});
it('rejects duplicate/foreign/unavailable selections and preserves retracted original export', () => {
  const evidence = input(); expect(() => previewCaseExport({ ...evidence, selection: { selectedIds: ['root', 'root'], includePrivate: false } })).toThrow('SELECTION');
  expect(() => previewCaseExport({ ...evidence, records: [record('root', { runId: 'foreign' })] })).toThrow('SCOPE');
  const original = record('root'), corrected = record('new', { supersedesId: 'root', kind: 'correction', actor: 'player', text: 'Private correction' });
  expect(previewCaseExport({ ...evidence, records: [original, corrected] }).snapshot.sources[0]).toMatchObject({ retracted: true, quote: original.text });
});
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test'; assertTestDatabase(database);
const namespace = 'case_export_' + randomUUID().replaceAll('-', ''), admin = new pg.Pool({ connectionString: database }), pool = new pg.Pool({ connectionString: database, options: `-c search_path=${namespace},public` }), repo = new PostgresRepository(pool);
beforeAll(async () => { await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate(); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); });
it('owned PG export permits committed sources and suppresses pending dialogue/foreign readers', async () => {
  const userId = await repo.upsertUser('fixture', randomUUID()), run = await repo.createRun({ userId, storyVersion: 'full-memory-v2', initialCheckpoint: { day: 1, beatId: 'b', sceneId: 's', stepIndex: 0, scheduleIndex: 0, phase: 'dialogue' } });
  for (const [index, id] of ['committed', 'pending'].entries()) {
    const source = record(id, { userId, runId: run.id, sequence: index + 1 });
    await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [run.id, source.eventId, userId, index + 1, id === 'pending' ? 'turn_committed' : 'fixture_source', {}, 'fixture']);
    const c = await pool.connect(); try { const serialized = serializeMemoryRecord(source); await repo.insertRecord(c, source, serialized.bytes, serialized.contentHash); } finally { c.release(); }
  }
  expect((await ownedExportPreview(repo, userId, run.id, { selectedIds: ['committed'], includePrivate: false })).snapshot.sources[0].quote).toBe('An exact original quote');
  await expect(ownedExportPreview(repo, userId, run.id, { selectedIds: ['pending'], includePrivate: false })).rejects.toThrow('SOURCE_UNAVAILABLE');
  await expect(ownedExportPreview(repo, 'foreign', run.id, { selectedIds: ['committed'], includePrivate: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

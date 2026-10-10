import { it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
import { contentHash, serializeMemoryRecord } from '../src/domain/serialization.js';
import { PostgresRepository } from '../src/persistence/repository.js';
import { assertTestDatabase } from '../src/persistence/transactions.js';
import { migrateCaseShares, ownedSharePreview, ownedCreateShare, ownedListShares, ownedRevokeShare, publicCaseShare } from '../src/evidence/sharing.js';
const database = process.env.DFM_TEST_DATABASE_URL ?? 'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';
assertTestDatabase(database);
const namespace = 'case_share_' + randomUUID().replaceAll('-', ''), admin = new pg.Pool({ connectionString: database }), pool = new pg.Pool({ connectionString: database, options: `-c search_path=${namespace},public` }), repo = new PostgresRepository(pool);
let userId: string, runId: string;
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${namespace}`); await repo.migrate(); await migrateCaseShares(repo);
  userId = await repo.upsertUser('fixture', randomUUID());
  runId = (await repo.createRun({ userId, storyVersion: 'full-memory-v2', initialCheckpoint: { day: 1, beatId: 'b', sceneId: 's', stepIndex: 0, scheduleIndex: 0, phase: 'dialogue' } })).id;
  for (const [index, id] of ['selected', 'ancestor', 'private'].entries()) {
    const record: MemoryRecordV2 = { schemaVersion: 2, id, eventId: `event-${id}`, userId, runId, sessionId: 'SECRET_SESSION', sequence: index + 1, storyVersion: 'full-memory-v2', beatId: 'b', inGameDay: 1, createdAt: '2026-10-09T00:00:00Z', actor: id === 'private' ? 'player' : 'binh', kind: id === 'private' ? 'conversation' : 'utterance', text: id === 'selected' ? '<img src=x onerror=alert(1)> Exact selected quote' : `SECRET_${id}`, epistemicStatus: 'said', sourceIds: id === 'selected' ? ['ancestor'] : [], originIds: [id], recipients: ['player', 'binh'], entityIds: [], propositionIds: [] };
    await pool.query('INSERT INTO domain_events(run_id,event_id,user_id,sequence,kind,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, record.eventId, userId, index + 1, 'fixture_source', {}, 'fixture']);
    const c = await pool.connect(); try { const s = serializeMemoryRecord(record); await repo.insertRecord(c, record, s.bytes, s.contentHash); } finally { c.release(); }
  }
});
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); });
const input = () => ({ selectedIds: ['selected'], includePrivate: false, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
async function create(selection = input()) {
  const preview = await ownedSharePreview(repo, userId, runId, selection);
  return ownedCreateShare(repo, userId, runId, { ...selection, confirmationHash: preview.confirmationHash, publicSharingConfirmed: true, clientActionId: randomUUID() });
}
it('publishes only selected redacted snapshot, stores token hash only and serves exact hostile text as data', async () => {
  const result = await create(), publicResult = await publicCaseShare(repo, result.token!);
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(publicResult.snapshot.sources).toHaveLength(1);
  expect(publicResult.snapshot.sources[0].quote).toContain('<img');
  expect(publicResult.snapshot.sources[0].selectedSourceReferences).toEqual([]);
  const json = JSON.stringify(publicResult);
  for (const secret of [userId, runId, 'SECRET_SESSION', 'SECRET_ancestor', 'SECRET_private', 'originIds', 'propositionIds']) expect(json).not.toContain(secret);
  const row = (await pool.query('SELECT * FROM case_shares WHERE id=$1', [result.id])).rows[0];
  expect(row.token_hash).toBe(contentHash(result.token!)); expect(JSON.stringify(row)).not.toContain(result.token!);
  expect(JSON.stringify(await ownedListShares(repo, userId, runId))).not.toContain(result.token!);
});
it('denies guessed malformed expired revoked and cross-owner access with no source payload', async () => {
  const share = await create();
  await expect(publicCaseShare(repo, 'guess')).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  await expect(publicCaseShare(repo, 'a'.repeat(43))).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  await expect(ownedRevokeShare(repo, randomUUID(), runId, share.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await ownedRevokeShare(repo, userId, runId, share.id);
  await expect(publicCaseShare(repo, share.token!)).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  expect((await ownedRevokeShare(repo, userId, runId, share.id)).revoked).toBe(true);
  const expired = await create(); await pool.query("UPDATE case_shares SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' WHERE id=$1", [expired.id]);
  await expect(publicCaseShare(repo, expired.token!)).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
});
it('requires public confirmation and exact selection expiry revision consent with explicit private opt-in', async () => {
  const selection = input(), preview = await ownedSharePreview(repo, userId, runId, selection);
  const base = { ...selection, confirmationHash: preview.confirmationHash, publicSharingConfirmed: true as const, clientActionId: randomUUID() };
  await expect(ownedCreateShare(repo, userId, runId, { ...base, publicSharingConfirmed: false as any })).rejects.toThrow();
  await expect(ownedCreateShare(repo, userId, runId, { ...base, expiresAt: new Date(Date.now() + 7200_000).toISOString() })).rejects.toMatchObject({ code: 'SHARE_CONSENT_STALE' });
  await expect(ownedSharePreview(repo, userId, runId, { ...selection, selectedIds: ['private'] })).rejects.toThrow('OPT_IN');
  expect((await create({ ...input(), selectedIds: ['private'], includePrivate: true })).includesPrivate).toBe(true);
  await expect(ownedSharePreview(repo, userId, runId, { ...selection, selectedIds: ['foreign'] })).rejects.toThrow('SOURCE_UNAVAILABLE');
  await expect(ownedSharePreview(repo, userId, runId, { ...selection, selectedIds: ["selected' OR 1=1 --"] })).rejects.toThrow('SOURCE_UNAVAILABLE');
  await expect(ownedSharePreview(repo, randomUUID(), runId, selection)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await pool.query('UPDATE runs SET revision=revision+1 WHERE id=$1', [runId]);
  await expect(ownedCreateShare(repo, userId, runId, base)).rejects.toMatchObject({ code: 'SHARE_CONSENT_STALE' });
  await expect(ownedSharePreview(repo, userId, runId, { ...selection, expiresAt: new Date(Date.now() + 8 * 86400_000).toISOString() })).rejects.toMatchObject({ code: 'SHARE_EXPIRY_OUT_OF_BOUNDS' });
});
it('rejects same-owner cross-run source selection and share revocation', async () => {
  const share = await create();
  const otherRun = await repo.createRun({ userId, storyVersion: 'full-memory-v2', initialCheckpoint: { day: 1, beatId: 'b', sceneId: 's', stepIndex: 0, scheduleIndex: 0, phase: 'dialogue' } });
  await expect(ownedSharePreview(repo, userId, otherRun.id, input())).rejects.toThrow('SOURCE_UNAVAILABLE');
  await expect(ownedRevokeShare(repo, userId, otherRun.id, share.id)).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  expect((await publicCaseShare(repo, share.token!)).snapshot.sources).toHaveLength(1);
});
it('serializes concurrent identical creation with one token issuance and rejects changed idempotency request', async () => {
  const selection = input(), preview = await ownedSharePreview(repo, userId, runId, selection), request = { ...selection, confirmationHash: preview.confirmationHash, publicSharingConfirmed: true as const, clientActionId: randomUUID() };
  const results = await Promise.all([ownedCreateShare(repo, userId, runId, request), ownedCreateShare(repo, userId, runId, request)]);
  expect(results[0].id).toBe(results[1].id); expect(results.filter(x => x.token)).toHaveLength(1); expect(results.filter(x => x.replayed)).toHaveLength(1);
  await expect(ownedCreateShare(repo, userId, runId, { ...request, includePrivate: true })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('creates with a single database connection without nested pool checkout', async () => {
  const singlePool = new pg.Pool({ connectionString: database, max: 1, connectionTimeoutMillis: 800, options: `-c search_path=${namespace},public` });
  const singleRepo = new PostgresRepository(singlePool);
  try {
    const selection = input(), preview = await ownedSharePreview(singleRepo, userId, runId, selection);
    const result = await ownedCreateShare(singleRepo, userId, runId, { ...selection, confirmationHash: preview.confirmationHash, publicSharingConfirmed: true, clientActionId: randomUUID() });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await publicCaseShare(singleRepo, result.token!)).snapshot.sources).toHaveLength(1);
  } finally { await singlePool.end(); }
});

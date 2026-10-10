import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalSerialize, contentHash } from '../domain/serialization.js';
import { AuthorityError, transaction } from '../persistence/transactions.js';
import type { PostgresRepository } from '../persistence/repository.js';
import { ownedExportPreview, ownedCaseExport, type OwnedExportContext } from './export.js';

export const sharePreviewSchema = z.object({ selectedIds: z.array(z.string().min(1).max(256)).min(1).max(100), includePrivate: z.boolean().default(false), expiresAt: z.string().datetime({ offset: true }) }).strict();
export const shareCreateSchema = sharePreviewSchema.extend({ confirmationHash: z.string().regex(/^[a-f0-9]{64}$/), publicSharingConfirmed: z.literal(true), clientActionId: z.string().min(1).max(128) }).strict();
export type SharePreviewInput = z.input<typeof sharePreviewSchema>;
export type ShareCreateInput = z.input<typeof shareCreateSchema>;
function expiry(value: string) {
  const ms = Date.parse(value), now = Date.now();
  if (!Number.isFinite(ms) || ms < now + 60_000 || ms > now + 7 * 86400_000) throw new AuthorityError('SHARE_EXPIRY_OUT_OF_BOUNDS', 400);
  return new Date(ms).toISOString();
}
export async function migrateCaseShares(repo: PostgresRepository) {
  const sql = await readFile(new URL('../../migrations/003_case_shares.sql', import.meta.url), 'utf8');
  await transaction(repo.pool, async c => { await c.query('SELECT pg_advisory_xact_lock(8798005)'); await c.query(sql); });
}
export async function ownedSharePreview(repo: PostgresRepository, userId: string, runId: string, raw: SharePreviewInput, context?: OwnedExportContext) {
  const input = sharePreviewSchema.parse(raw), expiresAt = expiry(input.expiresAt);
  const exported = await ownedExportPreview(repo, userId, runId, { selectedIds: input.selectedIds, includePrivate: input.includePrivate }, context);
  return { ...exported, expiresAt, exportConfirmationHash: exported.confirmationHash,
    confirmationHash: contentHash(canonicalSerialize({ exportConfirmationHash: exported.confirmationHash, expiresAt, publicSharingConfirmed: true })),
    disclosure: 'Anyone with the bearer link can read these selected quotes until expiry or revocation. Public sharing requires separate confirmation. Copies already saved by viewers cannot be recalled.' };
}
const metadata = (row: any) => ({ id: row.id as string, snapshotHash: row.snapshot_hash as string, includesPrivate: row.includes_private as boolean, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null });
export async function ownedCreateShare(repo: PostgresRepository, userId: string, runId: string, raw: ShareCreateInput) {
  const input = shareCreateSchema.parse(raw);
  const requestHash = contentHash(canonicalSerialize(input));
  return transaction(repo.pool, async c => {
    const run = await repo.lockedRun(c, userId, runId);
    const existing = await c.query('SELECT * FROM case_shares WHERE user_id=$1 AND run_id=$2 AND client_action_id=$3', [userId, runId, input.clientActionId]);
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== requestHash) throw new AuthorityError('IDEMPOTENCY_CONFLICT');
      return { ...metadata(existing.rows[0]), replayed: true, token: null };
    }
    const context = { client: c, run };
    const preview = await ownedSharePreview(repo, userId, runId, { selectedIds: input.selectedIds, includePrivate: input.includePrivate, expiresAt: input.expiresAt }, context);
    if (preview.confirmationHash !== input.confirmationHash) throw new AuthorityError('SHARE_CONSENT_STALE');
    const exported = await ownedCaseExport(repo, userId, runId, { selectedIds: input.selectedIds, includePrivate: input.includePrivate }, preview.exportConfirmationHash, context);
    // Run mutations use the same row lock; selection and revision cannot change during creation.
    const token = randomBytes(32).toString('base64url');
    const rows = await c.query('INSERT INTO case_shares(id,user_id,run_id,client_action_id,request_hash,token_hash,snapshot,snapshot_hash,includes_private,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [randomUUID(), userId, runId, input.clientActionId, requestHash, contentHash(token), exported.snapshot, exported.snapshotHash, input.includePrivate, preview.expiresAt]);
    return { ...metadata(rows.rows[0]), token, replayed: false };
  });
}
export async function ownedListShares(repo: PostgresRepository, userId: string, runId: string) {
  await repo.getRun(userId, runId);
  const rows = await repo.pool.query('SELECT id,snapshot_hash,includes_private,created_at,expires_at,revoked_at FROM case_shares WHERE user_id=$1 AND run_id=$2 ORDER BY created_at DESC', [userId, runId]);
  return { shares: rows.rows.map(metadata) };
}
export async function ownedRevokeShare(repo: PostgresRepository, userId: string, runId: string, id: string) {
  await repo.getRun(userId, runId);
  const rows = await repo.pool.query('UPDATE case_shares SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 AND run_id=$3 RETURNING *', [id, userId, runId]);
  if (!rows.rowCount) throw new AuthorityError('SHARE_UNAVAILABLE', 404);
  return { ...metadata(rows.rows[0]), revoked: true };
}
export async function publicCaseShare(repo: PostgresRepository, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthorityError('SHARE_UNAVAILABLE', 404);
  const rows = await repo.pool.query(`SELECT s.snapshot,s.snapshot_hash,s.expires_at FROM case_shares s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT EXISTS (
    SELECT 1 FROM memory_tombstones t JOIN memory_records m ON m.id=t.record_id AND m.user_id=t.user_id AND m.run_id=t.run_id
    CROSS JOIN LATERAL jsonb_array_elements(s.snapshot->'sources') source
    WHERE t.user_id=s.user_id AND t.run_id=s.run_id AND m.content_hash=source->>'sourceCanonicalHash'
  )`, [contentHash(token)]);
  if (!rows.rowCount) throw new AuthorityError('SHARE_UNAVAILABLE', 404);
  return { snapshot: rows.rows[0].snapshot, snapshotHash: rows.rows[0].snapshot_hash, expiresAt: new Date(rows.rows[0].expires_at).toISOString() };
}

import type { MemoryRecordV2, MemoryReceipt } from '../domain/contracts.js';
import { canonicalSerialize, contentHash, serializeMemoryRecord, verifySerializedRecord } from '../domain/serialization.js';
import { propositions } from '../story/canon.js';
import { scopedRecordIndex, type EvidenceScope } from './origins.js';
import type { PostgresRepository } from '../persistence/repository.js';
import { AuthorityError } from '../persistence/transactions.js';
import type { AuthoritativeRun } from '../persistence/repository.js';
import type pg from 'pg';
import { withoutTombstones } from '../memory/tombstones.js';

export interface ExportSelection { selectedIds: string[]; includePrivate: boolean }
export interface ExportInput { scope: EvidenceScope & { revision: number }; records: readonly MemoryRecordV2[]; receipts: readonly MemoryReceipt[]; selection: ExportSelection }
export interface ExportSnapshot {
  schemaVersion: 1; snapshotId: string; provenance: 'selected_local_ledger'; personalOwnershipProven: false;
  sources: Array<{ referenceId: string; actor: MemoryRecordV2['actor']; kind: MemoryRecordV2['kind']; epistemicStatus: MemoryRecordV2['epistemicStatus']; quote: string; sourceCreatedAt: string; inGameDay: number; sequence: number; storyVersion: string; sourceCanonicalHash: string; selectedSourceReferences: string[]; retracted: boolean;
    receipt?: { network: MemoryReceipt['network']; state: MemoryReceipt['state']; blobId?: string; verifiedAt?: string; lastRecallAt?: string } }>;
}
function privateRecord(record: MemoryRecordV2, index: Map<string, MemoryRecordV2>): boolean {
  if (record.actor === 'player' && ['conversation', 'hypothesis', 'interpretation', 'alias', 'correction'].includes(record.kind)) return true;
  if (record.propositionIds.some(id => propositions.some(p => p.id === id && (p.clueTags.includes('private_witness') || p.disclosure === 'trusted_witness' || p.disclosure === 'never_prompt')))) return true;
  return record.sourceIds.some(id => { const source = index.get(id); return source ? privateRecord(source, index) : true; });
}
function snapshot(input: ExportInput): ExportSnapshot {
  const index = scopedRecordIndex(input.scope, input.records), selected = new Set(input.selection.selectedIds);
  if (!Number.isSafeInteger(input.scope.revision) || input.scope.revision < 0 || selected.size !== input.selection.selectedIds.length || selected.size < 1 || selected.size > 100) throw new Error('INVALID_EXPORT_SELECTION');
  const reference = (id: string) => `source-${contentHash(canonicalSerialize({ userId: input.scope.userId, runId: input.scope.runId, id })).slice(0, 24)}`;
  return { schemaVersion: 1, snapshotId: `case-${contentHash(canonicalSerialize({ scope: input.scope, selectedIds: [...selected].sort(), includePrivate: input.selection.includePrivate })).slice(0, 24)}`, provenance: 'selected_local_ledger', personalOwnershipProven: false,
    sources: input.selection.selectedIds.map(id => {
      const record = index.get(id); if (!record || !record.recipients.includes('player')) throw new Error('EXPORT_SOURCE_UNAVAILABLE');
      if (!input.selection.includePrivate && privateRecord(record, index)) throw new Error('PRIVATE_EXPORT_OPT_IN_REQUIRED');
      const hash = serializeMemoryRecord(record).contentHash;
      const receipt = input.receipts.find(item => item.recordId === id && item.contentHash === hash);
      return { referenceId: reference(id), actor: record.actor, kind: record.kind, epistemicStatus: record.epistemicStatus, quote: record.text, sourceCreatedAt: record.createdAt, inGameDay: record.inGameDay, sequence: record.sequence, storyVersion: record.storyVersion, sourceCanonicalHash: hash,
        selectedSourceReferences: record.sourceIds.filter(source => selected.has(source)).map(reference), retracted: input.records.some(item => item.supersedesId === id),
        ...(receipt ? { receipt: { network: receipt.network, state: receipt.state, ...(receipt.blobId ? { blobId: receipt.blobId } : {}), ...(receipt.verifiedAt ? { verifiedAt: receipt.verifiedAt } : {}), ...(receipt.lastRecallAt ? { lastRecallAt: receipt.lastRecallAt } : {}) } } : {}) };
    }) };
}
export function previewCaseExport(input: ExportInput) {
  const value = snapshot(input), snapshotJson = canonicalSerialize(value), snapshotHash = contentHash(snapshotJson);
  const consent = { scope: input.scope, selection: input.selection, snapshotHash };
  return { snapshot: value, snapshotHash, confirmationHash: contentHash(canonicalSerialize(consent)), includesPrivate: input.selection.includePrivate,
    disclosure: 'This selected export contains exact quotes and source timestamps. Original source hashes identify unsanitized canonical records; the separate snapshot hash covers only this redacted export. It does not prove personal ownership. Private content requires explicit opt-in.' };
}
const escapeMarkdown=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_[\]{}()!])/g,'\\$1');
export function exportCase(input: ExportInput, confirmationHash: string) {
  const preview = previewCaseExport(input);
  if (confirmationHash !== preview.confirmationHash) throw new Error('EXPORT_CONSENT_STALE');
  const markdown = ['# Selected case sources', '', `Snapshot: ${preview.snapshot.snapshotId}`, `Snapshot SHA-256: ${preview.snapshotHash}`, '', 'Selected local ledger export. Personal ownership is not proven. Original canonical hashes do not hash this redacted snapshot.', '', ...preview.snapshot.sources.flatMap(source => [
    `## ${source.referenceId}`, '', `${source.actor} — ${source.kind} / ${source.epistemicStatus}; day ${source.inGameDay}; ${source.sourceCreatedAt}${source.retracted ? '; retracted original retained' : ''}`, '', ...source.quote.split(/\r?\n/).map(line => `> ${escapeMarkdown(line)}`), '', `Original canonical SHA-256: ${source.sourceCanonicalHash}`, '',
  ])].join('\n');
  return { snapshot: preview.snapshot, snapshotHash: preview.snapshotHash, json: canonicalSerialize(preview.snapshot), markdown };
}
/** A redacted snapshot is a reference bundle, never original canonical record bytes. */
export function verifyExportReferences(snapshot: ExportSnapshot, snapshotHash: string, originals: readonly { bytes: string; sourceCanonicalHash: string }[]) {
  if (snapshot.schemaVersion !== 1 || contentHash(canonicalSerialize(snapshot)) !== snapshotHash) throw new Error('EXPORT_SNAPSHOT_HASH_MISMATCH');
  const expected = new Set(snapshot.sources.map(source => source.sourceCanonicalHash));
  const verified = new Set<string>();
  for (const original of originals) {
    if (!expected.has(original.sourceCanonicalHash)) throw new Error('EXPORT_REFERENCE_NOT_SELECTED');
    const record = verifySerializedRecord(original.bytes, original.sourceCanonicalHash);
    const source = snapshot.sources.find(item => item.sourceCanonicalHash === original.sourceCanonicalHash)!;
    if (record.text !== source.quote || record.actor !== source.actor || record.kind !== source.kind || record.epistemicStatus !== source.epistemicStatus || record.inGameDay !== source.inGameDay || record.createdAt !== source.sourceCreatedAt || record.storyVersion !== source.storyVersion || record.sequence !== source.sequence) throw new Error('EXPORT_REFERENCE_METADATA_MISMATCH');
    verified.add(original.sourceCanonicalHash);
  }
  return { verifiedSourceCanonicalHashes: [...verified].sort(), missingSourceCanonicalHashes: [...expected].filter(hash => !verified.has(hash)).sort(), personalOwnershipProven: false, importedAsCanonicalRecord: false };
}
export interface OwnedExportContext { client: pg.PoolClient; run: AuthoritativeRun }
async function ownedInput(repo: PostgresRepository, userId: string, runId: string, selection: ExportSelection, context?: OwnedExportContext): Promise<ExportInput> {
  const run = context?.run ?? await repo.getRun(userId, runId);
  if (run.userId !== userId || run.id !== runId) throw new AuthorityError('FORBIDDEN', 403);
  const rows = await (context?.client ?? repo.pool).query(`SELECT m.payload_bytes,m.content_hash,r.receipt FROM memory_records m JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id LEFT JOIN LATERAL (SELECT receipt FROM memory_receipts WHERE record_id=m.id ORDER BY updated_at DESC LIMIT 1) r ON true WHERE m.user_id=$1 AND m.run_id=$2 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed')) ORDER BY m.sequence,m.id`, [userId, runId]);
  const records = await withoutTombstones(context?.client ?? repo.pool, userId, runId, rows.rows.map(row => verifySerializedRecord(row.payload_bytes, row.content_hash)).filter(record => record.inGameDay <= run.checkpoint.day));
  return { scope: { userId, runId, revision: run.revision }, records, receipts: rows.rows.filter(row => row.receipt).map(row => row.receipt), selection };
}
export async function ownedExportPreview(repo: PostgresRepository, userId: string, runId: string, selection: ExportSelection, context?: OwnedExportContext) {
  return previewCaseExport(await ownedInput(repo, userId, runId, selection, context));
}
export async function ownedCaseExport(repo: PostgresRepository, userId: string, runId: string, selection: ExportSelection, confirmationHash: string, context?: OwnedExportContext) {
  const input = await ownedInput(repo, userId, runId, selection, context);
  try { return exportCase(input, confirmationHash); } catch (error) { if (error instanceof Error && error.message === 'EXPORT_CONSENT_STALE') throw new AuthorityError('EXPORT_CONSENT_STALE'); throw error; }
}

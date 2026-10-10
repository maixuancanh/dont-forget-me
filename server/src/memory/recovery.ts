import { z } from 'zod';
import type { MemWal } from '@mysten-incubation/memwal';
import type { MemoryReceipt, MemoryRecordV2 } from '../domain/contracts.js';
import { canonicalSerialize, contentHash, verifySerializedRecord } from '../domain/serialization.js';
import { operationNamespace, validateRecoveryManifest, type OperationScope, type RecoveryManifest } from './operations.js';

const anchorSchema = z.object({ blobId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type RecoveryAnchor = z.infer<typeof anchorSchema>;
const entrySchema = z.object({ recordId: z.string().min(1), sequence: z.number().int().nonnegative(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), blobId: z.string().min(1), receipt: z.custom<MemoryReceipt>(v => !!v && typeof v === 'object') }).strict();
const chunkSchema = z.object({ schemaVersion: z.literal(2), userId: z.string(), runId: z.string(), storyVersion: z.string().min(1), entries: z.array(entrySchema).max(100) }).strict();
const directorySchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('dfm-recovery-directory'), userId: z.string(), runId: z.string(), storyVersion: z.string().min(1), generation: z.number().int().nonnegative(), previous: anchorSchema.optional(), chunks: z.array(anchorSchema), authority: anchorSchema.optional(), tombstoneIds: z.array(z.string().min(1)), recordCount: z.number().int().nonnegative() }).strict();
export type RecoveryDirectory = z.infer<typeof directorySchema>;
export interface ExactRecoveryStore {
  provenance?: 'exact_remote_manifest_replay' | 'verified_reference_manifest_replay';
  /** Must enumerate every authorized on-chain namespace entry, including old heads. Never semantic recall. */
  directory(scope: OperationScope, namespace: string): Promise<{ anchors: RecoveryAnchor[]; complete: boolean }>;
  /** Authorized decrypted bytes for this exact blob. No local payload fallback. */
  read(scope: OperationScope, anchor: RecoveryAnchor): Promise<string>;
  write(scope: OperationScope, namespace: string, bytes: string, idempotencyKey: string): Promise<RecoveryAnchor>;
}
export function recoveryDirectoryNamespace(scope: OperationScope) {
  operationNamespace(scope); // validate opaque authenticated scope
  return `dfm:v2:${scope.userId}:directory`;
}
/** Concrete installed SDK write path. Reader/enumerator must be supplied by authorized chain/Seal adapter. */
export function sdkRecoveryStore(sdkFor: (scope: OperationScope) => Promise<Pick<MemWal, 'rememberAndWait'>>, exact: Pick<ExactRecoveryStore, 'directory' | 'read'>): ExactRecoveryStore {
  return { ...exact, async write(scope, namespace, bytes, idempotencyKey) {
    const result = await (await sdkFor(scope)).rememberAndWait(bytes, namespace, { idempotencyKey, timeoutMs: 120000 });
    if (result.owner !== scope.owner || result.namespace !== namespace || !result.blob_id) throw new Error('RECOVERY_WRITE_SCOPE_MISMATCH');
    const anchor = { blobId: result.blob_id, contentHash: contentHash(bytes) };
    if (await exact.read(scope, anchor) !== bytes) throw new Error('RECOVERY_WRITE_NOT_VERIFIED');
    return anchor;
  } };
}
function parseExact(bytes: string, anchor: RecoveryAnchor) {
  anchorSchema.parse(anchor);
  if (contentHash(bytes) !== anchor.contentHash) throw new Error('RECOVERY_HASH_MISMATCH');
  const parsed: unknown = JSON.parse(bytes);
  if (canonicalSerialize(parsed) !== bytes) throw new Error('RECOVERY_NON_CANONICAL');
  return parsed;
}
function assertDirectoryScope(scope: OperationScope, value: RecoveryDirectory) {
  if (value.userId !== scope.userId || value.runId !== scope.runId) throw new Error('RECOVERY_DIRECTORY_SCOPE_MISMATCH');
  if (new Set(value.chunks.map(c => c.blobId)).size !== value.chunks.length || new Set(value.tombstoneIds).size !== value.tombstoneIds.length) throw new Error('RECOVERY_DIRECTORY_DUPLICATE');
}
export class MemoryRecoveryService {
  constructor(private store: ExactRecoveryStore) {}
  async publish(scope: OperationScope, input: { storyVersion: string; generation: number; previous?: RecoveryAnchor; records: readonly { bytes: string; receipt: MemoryReceipt }[]; tombstoneIds: string[]; authorityBytes?: string }) {
    const records = input.records.map(item => ({ record: verifySerializedRecord(item.bytes, item.receipt.contentHash), ...item }));
    if (new Set(records.map(r => r.record.id)).size !== records.length) throw new Error('MANIFEST_DUPLICATE_ENTRY');
    const denied = new Set(input.tombstoneIds);
    const entries = records.filter(r => !denied.has(r.record.id)).sort((a,b) => a.record.sequence-b.record.sequence || a.record.id.localeCompare(b.record.id)).map(({record, receipt}) => {
      if (record.userId !== scope.userId || record.runId !== scope.runId || record.storyVersion !== input.storyVersion || receipt.recordId !== record.id || receipt.accountBindingId !== scope.accountBindingId || receipt.network !== scope.network || receipt.namespace !== operationNamespace(scope) || receipt.state !== 'retrievable' || !receipt.blobId) throw new Error('RECOVERY_RECEIPT_SCOPE_MISMATCH');
      return { recordId: record.id, sequence: record.sequence, contentHash: receipt.contentHash, blobId: receipt.blobId, receipt };
    });
    if (input.previous) {
      const previous = directorySchema.parse(parseExact(await this.store.read(scope, input.previous), input.previous)); assertDirectoryScope(scope, previous);
      if (input.generation !== previous.generation+1 || input.storyVersion !== previous.storyVersion || previous.tombstoneIds.some(id => !denied.has(id))) throw new Error('RECOVERY_HISTORY_REGRESSION');
    } else if (input.generation !== 0) throw new Error('RECOVERY_PREVIOUS_REQUIRED');
    const chunks: RecoveryAnchor[] = [];
    for (let offset = 0; offset < entries.length; offset += 100) {
      const bytes = canonicalSerialize(chunkSchema.parse({ schemaVersion: 2, userId: scope.userId, runId: scope.runId, storyVersion: input.storyVersion, entries: entries.slice(offset,offset+100) }));
      chunks.push(await this.store.write(scope, operationNamespace(scope,'manifests'), bytes, `dfm-manifest-${contentHash(bytes)}`));
    }
    const authority = input.authorityBytes ? await this.store.write(scope, operationNamespace(scope,'manifests'), input.authorityBytes, `dfm-authority-${contentHash(input.authorityBytes)}`) : undefined;
    const directory = directorySchema.parse({ schemaVersion: 2, kind: 'dfm-recovery-directory', userId: scope.userId, runId: scope.runId, storyVersion: input.storyVersion, generation: input.generation, ...(input.previous ? { previous: input.previous } : {}), ...(authority ? { authority } : {}), chunks, tombstoneIds: [...denied].sort(), recordCount: entries.length });
    const bytes = canonicalSerialize(directory);
    // Publish only after all chunks have been uploaded and read back; orphan chunks cannot become a head.
    const anchor = await this.store.write(scope, recoveryDirectoryNamespace(scope), bytes, `dfm-directory-${contentHash(bytes)}`);
    return { directory, anchor };
  }
  async readAuthority(scope: OperationScope, directory: RecoveryDirectory): Promise<unknown> {
    assertDirectoryScope(scope,directory);
    if (!directory.authority) throw new Error('RECOVERY_AUTHORITY_ENVELOPE_UNAVAILABLE');
    return parseExact(await this.store.read(scope,directory.authority),directory.authority);
  }
  async discover(scope: OperationScope) {
    const page = await this.store.directory(scope, recoveryDirectoryNamespace(scope));
    if (!page.complete) throw new Error('RECOVERY_DIRECTORY_ENUMERATION_INCOMPLETE');
    const heads: { anchor: RecoveryAnchor; directory: RecoveryDirectory }[] = [];
    for (const anchor of page.anchors) {
      const directory = directorySchema.parse(parseExact(await this.store.read(scope, anchor),anchor));
      if (directory.userId !== scope.userId) throw new Error('RECOVERY_DIRECTORY_SCOPE_MISMATCH');
      if (directory.runId !== scope.runId) continue;
      assertDirectoryScope(scope,directory); heads.push({anchor,directory});
    }
    if (!heads.length) throw new Error('RECOVERY_DIRECTORY_UNAVAILABLE');
    heads.sort((a,b) => b.directory.generation-a.directory.generation);
    if (heads[1]?.directory.generation === heads[0].directory.generation && heads[1].anchor.contentHash !== heads[0].anchor.contentHash) throw new Error('RECOVERY_DIRECTORY_FORK');
    // Validate ancestry and monotonic tombstones to reject an incomplete/fabricated newest head.
    const byHash = new Map(heads.map(h => [h.anchor.contentHash,h])); let current = heads[0];
    while (current.directory.generation > 0) {
      const prior = current.directory.previous && byHash.get(current.directory.previous.contentHash);
      if (!prior || prior.anchor.blobId !== current.directory.previous!.blobId || prior.directory.generation !== current.directory.generation-1 || prior.directory.storyVersion !== current.directory.storyVersion || prior.directory.tombstoneIds.some(id => !current.directory.tombstoneIds.includes(id))) throw new Error('RECOVERY_DIRECTORY_HISTORY_INCOMPLETE');
      current = prior;
    }
    return heads[0];
  }
  async rebuild(scope: OperationScope, anchor: RecoveryAnchor, expectedStoryVersion: string) {
    const directory = directorySchema.parse(parseExact(await this.store.read(scope,anchor),anchor)); assertDirectoryScope(scope,directory);
    if (directory.storyVersion !== expectedStoryVersion) throw new Error('RECOVERY_STORY_VERSION_MISMATCH');
    const chunks = await Promise.all(directory.chunks.map(async a => chunkSchema.parse(parseExact(await this.store.read(scope,a),a))));
    if (chunks.some(c => c.userId !== scope.userId || c.runId !== scope.runId || c.storyVersion !== expectedStoryVersion)) throw new Error('MANIFEST_SCOPE_OR_SCHEMA_MISMATCH');
    const entries = chunks.flatMap(c => c.entries);
    if (entries.length !== directory.recordCount) throw new Error('RECOVERY_RECORD_COUNT_MISMATCH');
    const tombstones = new Set(directory.tombstoneIds);
    if (entries.some(e => tombstones.has(e.recordId))) throw new Error('RECOVERY_TOMBSTONE_RESURRECTION');
    const blobs: { blobId: string; bytes: string; receipt: MemoryReceipt }[] = [], unavailableIds: string[] = [];
    for (const e of entries) {
      try { blobs.push({ blobId:e.blobId, bytes:await this.store.read(scope,e),receipt:e.receipt }); }
      catch { unavailableIds.push(e.recordId); }
    }
    const manifest: RecoveryManifest = { schemaVersion:2,userId:scope.userId,runId:scope.runId,storyVersion:expectedStoryVersion,entries };
    const validation = validateRecoveryManifest(scope,manifest,blobs);
    // Deleted ancestors block descendants; never rebuild them as independent facts.
    const blocked = new Set(tombstones); let changed = true;
    while (changed) { changed = false; for (const r of validation.records) if (!blocked.has(r.id) && [...r.sourceIds,...r.originIds.filter(id=>id!==r.id),...(r.supersedesId?[r.supersedesId]:[])].some(id=>blocked.has(id))) { blocked.add(r.id); changed=true; } }
    const records = validation.records.filter(r => !blocked.has(r.id));
    const missingSources = validation.unavailableSources.filter(id => !tombstones.has(id));
    const complete = validation.missingIds.length === 0 && missingSources.length === 0;
    return { directory, records, receipts: blobs.filter(b=>records.some(r=>r.id===b.receipt.recordId)).map(b=>b.receipt), tombstoneIds: [...tombstones], blockedRecordIds: [...blocked].filter(id=>!tombstones.has(id)), unavailableIds, missingSources, completeness: complete ? 'verified' as const : 'partial' as const, projectionReadOnly: !complete, projection: replayRecoveredRecords(records), provenance: this.store.provenance ?? 'exact_remote_manifest_replay' };
  }
}
/** Rebuild durable record projections without claiming checkpoint/auth restoration from prose. */
export function replayRecoveredRecords(records: readonly MemoryRecordV2[]) {
  const ordered = [...records].sort((a,b)=>a.sequence-b.sequence || a.id.localeCompare(b.id));
  return { orderedRecordIds: ordered.map(r=>r.id), knownRecordIdsByActor: Object.fromEntries(['player','binh','hanh','bao','lan','thu','sau','duy','tuan','phuc'].map(actor=>[actor,ordered.filter(r=>r.recipients.includes(actor as never)).map(r=>r.id)])), corrections: ordered.filter(r=>r.kind==='correction').map(r=>({id:r.id,supersedesId:r.supersedesId,sourceIds:r.sourceIds})), promises: ordered.filter(r=>r.kind==='promise'), tasks: ordered.filter(r=>r.kind==='task'), disclosures: ordered.filter(r=>r.kind==='disclosure'), aliases: ordered.filter(r=>r.kind==='alias'), outcomes: ordered.filter(r=>r.kind==='outcome') };
}

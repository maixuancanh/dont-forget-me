import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MemWal } from '@mysten-incubation/memwal';
import type { MemoryReceipt } from '../domain/contracts.js';
import { canonicalSerialize, contentHash, verifySerializedRecord } from '../domain/serialization.js';
import { scopedRecordIndex } from '../evidence/origins.js';

/** Structural interface is checked against the installed real SDK, not speculative APIs. */
export type OperationsSdk = Pick<MemWal, 'analyzeAndWait' | 'restore' | 'listNamespaces'>;
export type OperationsSdkResolver = (scope: OperationScope) => Promise<OperationsSdk>;
export interface OperationScope { userId: string; runId: string; accountBindingId: string; owner: string; network: 'local' | 'mainnet'; revision: number; accountObjectId?: string }
export interface AnalyzeRequest { operationId: string; rawInputRecordId: string; text: string; occurredAt?: string }
export interface RecoveryManifest { schemaVersion: 2; userId: string; runId: string; storyVersion: string; entries: Array<{ recordId: string; sequence: number; contentHash: string; blobId: string }> }
const opaque = (value: string) => /^[a-zA-Z0-9_-]{1,200}$/.test(value);
function validScope(scope: OperationScope) {
  if (!opaque(scope.userId) || !opaque(scope.runId) || !scope.accountBindingId || !scope.owner || !Number.isSafeInteger(scope.revision) || scope.revision < 0) throw new Error('INVALID_OPERATION_SCOPE');
}
export function operationNamespace(scope: OperationScope, lane: 'case' | 'manifests' = 'case') {
  validScope(scope); return `dfm:v2:${scope.userId}:${scope.runId}:${lane}`;
}
export function previewAnalysis(scope: OperationScope, request: AnalyzeRequest) {
  validScope(scope);
  if (!opaque(request.operationId) || !request.rawInputRecordId || !request.text.trim() || request.text.length > 12000) throw new Error('INVALID_ANALYSIS_INPUT');
  if (request.occurredAt && !Number.isFinite(new Date(request.occurredAt).getTime())) throw new Error('INVALID_OCCURRED_AT');
  const preview = { scope: { ...scope }, request: { operationId: request.operationId, rawInputRecordId: request.rawInputRecordId, text: request.text, ...(request.occurredAt ? { occurredAt: request.occurredAt } : {}) }, namespace: `${operationNamespace(scope)}:candidates:${request.operationId}`,
    disclosure: 'This opt-in operation sends the selected note to the extractor and automatically stores extracted facts in a separate candidate namespace. Candidates require review and are not canonical evidence.' };
  return { ...preview, confirmationHash: contentHash(canonicalSerialize(preview)) };
}

export class MemoryOperations {
  constructor(private sdk: OperationsSdk | OperationsSdkResolver, private cursorSigningKey: string) {
    if (cursorSigningKey.length < 32) throw new Error('CURSOR_KEY_TOO_SHORT');
  }
  private async forScope(scope: OperationScope) {
    validScope(scope);
    return typeof this.sdk === 'function' ? this.sdk(scope) : this.sdk;
  }
  async analyze(scope: OperationScope, request: AnalyzeRequest, confirmation: { confirmed: true; confirmationHash: string }) {
    const preview = previewAnalysis(scope, request);
    if (confirmation.confirmed !== true || confirmation.confirmationHash !== preview.confirmationHash) throw new Error('ANALYSIS_CONSENT_STALE');
    const result = await (await this.forScope(scope)).analyzeAndWait(request.text, { namespace: preview.namespace, ...(request.occurredAt ? { occurredAt: request.occurredAt } : {}) }, { timeoutMs: 30000 });
    if (result.owner !== scope.owner || result.results.some(item => item.namespace !== preview.namespace)) throw new Error('ANALYSIS_RESPONSE_SCOPE_MISMATCH');
    return { operationId: request.operationId, rawInputRecordId: request.rawInputRecordId, namespace: preview.namespace,
      candidates: result.facts.map(fact => ({ ...fact, reviewState: 'unreviewed' as const, canonicalEvidence: false as const })),
      receipts: result.results, total: result.total, succeeded: result.succeeded, failed: result.failed,
      state: result.failed ? 'partial' as const : 'awaiting_review' as const, automaticallyStored: true as const };
  }
  private sign(scope: OperationScope, remoteCursor: string) {
    const payload = Buffer.from(canonicalSerialize({ userId: scope.userId, runId: scope.runId, accountBindingId: scope.accountBindingId, owner: scope.owner, network: scope.network, remoteCursor })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.cursorSigningKey).update(payload).digest('base64url')}`;
  }
  private cursor(scope: OperationScope, cursor: string) {
    if (cursor.length > 10000) throw new Error('INVALID_DISCOVERY_CURSOR');
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra) throw new Error('INVALID_DISCOVERY_CURSOR');
    const expected = createHmac('sha256', this.cursorSigningKey).update(payload).digest(), actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('INVALID_DISCOVERY_CURSOR');
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value.userId !== scope.userId || value.runId !== scope.runId || value.accountBindingId !== scope.accountBindingId || value.owner !== scope.owner || value.network !== scope.network || typeof value.remoteCursor !== 'string') throw new Error('DISCOVERY_CURSOR_SCOPE_MISMATCH');
    return value.remoteCursor as string;
  }
  async discover(scope: OperationScope, options: { cursor?: string; limit?: number } = {}) {
    validScope(scope); const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_DISCOVERY_LIMIT');
    const remoteCursor = options.cursor ? this.cursor(scope, options.cursor) : undefined;
    const page = await (await this.forScope(scope)).listNamespaces({ ...(remoteCursor ? { cursor: remoteCursor } : {}), limit });
    if (page.has_more && (!page.next_cursor || page.next_cursor === remoteCursor)) throw new Error('DISCOVERY_CURSOR_NOT_ADVANCING');
    const allowed = new Set([operationNamespace(scope), operationNamespace(scope, 'manifests'), `dfm:v2:${scope.userId}:directory`]);
    return { namespaces: page.namespaces.filter(item => allowed.has(item.name)), hasMore: page.has_more,
      nextCursor: page.next_cursor ? this.sign(scope, page.next_cursor) : undefined, snapshotVersion: page.snapshot_version,
      provenance: 'sdk_namespace_metadata' as const, manifestValidationRequired: true as const };
  }
  async restore(scope: OperationScope, request: { namespace: string; limit?: number }) {
    const allowed = [operationNamespace(scope), operationNamespace(scope, 'manifests')];
    if (!allowed.includes(request.namespace)) throw new Error('RESTORE_NAMESPACE_FORBIDDEN');
    const limit = request.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_RESTORE_LIMIT');
    const result = await (await this.forScope(scope)).restore(request.namespace, limit);
    if (result.namespace !== request.namespace || result.owner !== scope.owner) throw new Error('RESTORE_RESPONSE_SCOPE_MISMATCH');
    return { ...result, provenance: 'sdk_restore' as const, projectionReadOnly: true as const, completeness: 'unproven' as const,
      restoreCursorSupported: false as const, manifestValidationRequired: true as const };
  }
}

/** Validate individually fetched/decrypted bytes against a trusted manifest, never semantic top-K completeness. */
export function validateRecoveryManifest(scope: OperationScope, manifest: RecoveryManifest, blobs: readonly { blobId: string; bytes: string; receipt: MemoryReceipt }[]) {
  validScope(scope);
  if (manifest.schemaVersion !== 2 || manifest.userId !== scope.userId || manifest.runId !== scope.runId || !manifest.storyVersion) throw new Error('MANIFEST_SCOPE_OR_SCHEMA_MISMATCH');
  if (manifest.entries.some(item => !item.recordId || !item.blobId || !Number.isSafeInteger(item.sequence) || item.sequence < 0 || !/^[a-f0-9]{64}$/.test(item.contentHash))) throw new Error('INVALID_MANIFEST_ENTRY');
  if (new Set(manifest.entries.map(item => item.recordId)).size !== manifest.entries.length || new Set(manifest.entries.map(item => item.blobId)).size !== manifest.entries.length) throw new Error('MANIFEST_DUPLICATE_ENTRY');
  const expected = new Map(manifest.entries.map(item => [item.blobId, item])), records = new Map<string, ReturnType<typeof verifySerializedRecord>>();
  for (const blob of blobs) {
    const entry = expected.get(blob.blobId); if (!entry) throw new Error('UNEXPECTED_RECOVERY_BLOB');
    const record = verifySerializedRecord(blob.bytes, entry.contentHash), receipt = blob.receipt;
    if (record.id !== entry.recordId || record.userId !== scope.userId || record.runId !== scope.runId || record.storyVersion !== manifest.storyVersion || record.sequence !== entry.sequence) throw new Error('RECOVERY_RECORD_MISMATCH');
    if (receipt.recordId !== record.id || receipt.contentHash !== entry.contentHash || receipt.blobId !== blob.blobId || receipt.accountBindingId !== scope.accountBindingId || receipt.namespace !== operationNamespace(scope) || receipt.network !== scope.network || receipt.state !== 'retrievable') throw new Error('RECOVERY_RECEIPT_SCOPE_MISMATCH');
    if (records.has(record.id)) throw new Error('DUPLICATE_RECOVERY_BLOB'); records.set(record.id, record);
  }
  const missingIds = manifest.entries.filter(item => !records.has(item.recordId)).map(item => item.recordId);
  scopedRecordIndex(scope, [...records.values()]);
  const unavailableSources = [...new Set([...records.values()].flatMap(record => [...record.sourceIds, ...record.originIds.filter(id => id !== record.id), ...(record.supersedesId ? [record.supersedesId] : [])]).filter(id => !records.has(id)))];
  return { valid: missingIds.length === 0 && unavailableSources.length === 0, missingIds, unavailableSources,
    projectionReadOnly: missingIds.length > 0 || unavailableSources.length > 0, records: [...records.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)), provenance: 'verified_manifest_bytes' as const };
}

import { readFile } from 'node:fs/promises';
import type { PostgresRepository, AuthoritativeRun } from '../persistence/repository.js';
import { transaction, AuthorityError } from '../persistence/transactions.js';
import { canonicalSerialize, contentHash, verifySerializedRecord } from '../domain/serialization.js';
import { MemoryOperations, previewAnalysis, operationNamespace, type OperationScope } from './operations.js';
import type { MemoryRecoveryService } from './recovery.js';

export type OperationBinding = Omit<OperationScope, 'userId' | 'runId' | 'revision'>;
export type OperationAction = { kind: 'analyze'; operationId: string; rawInputRecordId: string } | { kind: 'restore'; operationId: string; lane: 'case' | 'manifests'; limit: number };
export interface OperationCommit { action: OperationAction; expectedRevision: number; clientActionId: string; confirmed: true; confirmationHash: string }
type Prepared = { kind: 'analyze'; preview: ReturnType<typeof previewAnalysis> } | { kind: 'restore'; preview: { scope: OperationScope; request: { namespace: string; limit: number }; disclosure: string; confirmationHash: string } };

/** External work is deliberately dispatched AFTER durable claim, outside SQL locks. */
export class MemoryOperationService {
  constructor(private repo: PostgresRepository, private operations: MemoryOperations, private binding: (run: AuthoritativeRun) => Promise<OperationBinding>, private deadlineMs = 35000, private recovery?: MemoryRecoveryService) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000) throw new Error('INVALID_OPERATION_DEADLINE');
  }
  async migrate() {
    const sql = await readFile(new URL('../../migrations/002_memory_operations.sql', import.meta.url), 'utf8');
    await transaction(this.repo.pool, async c => { await c.query('SELECT pg_advisory_xact_lock(8798006)'); await c.query(sql); });
  }
  private async scope(run: AuthoritativeRun): Promise<OperationScope> {
    const bound = await this.binding(run);
    const row = await this.repo.pool.query("SELECT id,account_id FROM account_bindings WHERE id=$1 AND user_id=$2 AND network=$3 AND status='active'", [bound.accountBindingId, run.userId, bound.network]);
    if (!row.rowCount) throw new AuthorityError('OPERATION_BINDING_UNAVAILABLE', 403);
    return { ...bound, userId: run.userId, runId: run.id, revision: run.revision, accountObjectId: row.rows[0].account_id };
  }
  private async prepare(run: AuthoritativeRun, scope: OperationScope, action: OperationAction, executor: Pick<PostgresRepository['pool'], 'query'>): Promise<Prepared> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(action.operationId)) throw new AuthorityError('INVALID_OPERATION_ID', 400);
    if (action.kind === 'analyze') {
      const row = (await executor.query(`SELECT m.payload_bytes,m.content_hash FROM memory_records m JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones d WHERE d.record_id=m.id AND d.run_id=m.run_id) AND m.id=$1 AND m.run_id=$2 AND m.user_id=$3 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed'))`, [action.rawInputRecordId, run.id, run.userId])).rows[0];
      if (!row) throw new AuthorityError('ANALYSIS_NOTE_UNAVAILABLE', 403);
      const record = verifySerializedRecord(row.payload_bytes, row.content_hash);
      if (record.userId !== run.userId || record.runId !== run.id || record.actor !== 'player' || !['hypothesis', 'interpretation', 'conversation', 'correction'].includes(record.kind) || !record.recipients.includes('player') || record.inGameDay > run.checkpoint.day) throw new AuthorityError('ANALYSIS_NOTE_UNAVAILABLE', 403);
      return { kind: 'analyze', preview: previewAnalysis(scope, { operationId: action.operationId, rawInputRecordId: record.id, text: record.text, occurredAt: record.createdAt }) };
    }
    if (!['case', 'manifests'].includes(action.lane) || !Number.isInteger(action.limit) || action.limit < 1 || action.limit > 100) throw new AuthorityError('INVALID_RESTORE_REQUEST', 400);
    const preview = { scope, request: { namespace: operationNamespace(scope, action.lane), limit: action.limit }, disclosure: 'This operation rebuilds the scoped relayer index. Results remain read-only and require trusted manifest validation; restore counts do not prove complete recovery.' };
    return { kind: 'restore', preview: { ...preview, confirmationHash: contentHash(canonicalSerialize(preview)) } };
  }
  async preview(userId: string, runId: string, action: OperationAction) {
    const run = await this.repo.getRun(userId, runId), scope = await this.scope(run);
    const prepared = await this.prepare(run, scope, action, this.repo.pool);
    return { kind: prepared.kind, operationId: action.operationId, ...prepared.preview };
  }
  async commit(userId: string, runId: string, input: OperationCommit) {
    if (input.confirmed !== true) throw new AuthorityError('OPERATION_CONSENT_REQUIRED', 400);
    const initial = await this.repo.getRun(userId, runId), scope = await this.scope(initial);
    return this.repo.mutateRun({ userId, runId, expectedRevision: input.expectedRevision, clientActionId: input.clientActionId, eventId: `memory-operation:${input.clientActionId}`, kind: 'memory_operation', payload: input }, async (c, run) => {
      if ((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1", [runId])).rowCount) throw new AuthorityError('TURN_ACK_REQUIRED');
      const bound = await c.query("SELECT id,account_id FROM account_bindings WHERE id=$1 AND user_id=$2 AND network=$3 AND status='active'", [scope.accountBindingId, userId, scope.network]);
      if (!bound.rowCount || bound.rows[0].account_id !== scope.accountObjectId) throw new AuthorityError('OPERATION_BINDING_UNAVAILABLE', 403);
      const prepared = await this.prepare(run, { ...scope, revision: run.revision }, input.action, c);
      if (prepared.preview.confirmationHash !== input.confirmationHash) throw new AuthorityError('OPERATION_CONSENT_STALE');
      if ((await c.query('SELECT operation_id FROM memory_operations WHERE run_id=$1 AND operation_id=$2', [runId, input.action.operationId])).rowCount) throw new AuthorityError('OPERATION_ID_REUSED');
      return { operationId: input.action.operationId, status: 'queued', prepared };
    }, async (c, _run, _sequence, result) => {
      const bytes = canonicalSerialize(result.prepared);
      await c.query('INSERT INTO memory_operations(run_id,operation_id,user_id,account_binding_id,kind,request_hash,confirmation_hash,request_bytes,scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [runId, result.operationId, userId, scope.accountBindingId, result.prepared.kind, contentHash(bytes), input.confirmationHash, bytes, result.prepared.preview.scope]);
    });
  }
  async read(userId: string, runId: string, operationId: string) {
    await this.repo.getRun(userId, runId);
    const row = (await this.repo.pool.query('SELECT operation_id,kind,status,result,error_code,dispatch_count FROM memory_operations WHERE user_id=$1 AND run_id=$2 AND operation_id=$3', [userId, runId, operationId])).rows[0];
    if (!row) throw new AuthorityError('OPERATION_UNAVAILABLE', 404);
    return { operationId: row.operation_id, kind: row.kind, status: row.status, result: row.result, errorCode: row.error_code, dispatchCount: row.dispatch_count };
  }
  async dispatch(userId: string, runId: string, operationId: string) {
    const run = await this.repo.getRun(userId, runId), currentScope = await this.scope(run);
    const row = (await this.repo.pool.query('SELECT * FROM memory_operations WHERE user_id=$1 AND run_id=$2 AND operation_id=$3', [userId, runId, operationId])).rows[0];
    if (!row) throw new AuthorityError('OPERATION_UNAVAILABLE', 404);
    if (row.status !== 'queued') return this.read(userId, runId, operationId);
    const prepared = JSON.parse(row.request_bytes) as Prepared, savedScope = prepared.preview.scope;
    if (contentHash(row.request_bytes) !== row.request_hash || canonicalSerialize(prepared) !== row.request_bytes || savedScope.userId !== userId || savedScope.runId !== runId || savedScope.accountBindingId !== currentScope.accountBindingId || savedScope.owner !== currentScope.owner || savedScope.network !== currentScope.network || savedScope.accountObjectId !== currentScope.accountObjectId) throw new AuthorityError('OPERATION_SCOPE_CHANGED');
    if(prepared.kind==='analyze'&&(await this.repo.pool.query('SELECT record_id FROM memory_tombstones WHERE record_id=$1 AND run_id=$2',[prepared.preview.request.rawInputRecordId,runId])).rowCount)throw new AuthorityError('MEMORY_BLOCKED');
    const claimed = await this.repo.pool.query("UPDATE memory_operations SET status='dispatched',dispatch_count=1,updated_at=now() WHERE user_id=$1 AND run_id=$2 AND operation_id=$3 AND status='queued' AND dispatch_count=0 AND NOT EXISTS (SELECT 1 FROM memory_tombstones d WHERE d.run_id=$2 AND d.record_id=$4) RETURNING operation_id", [userId, runId, operationId,prepared.kind==='analyze'?prepared.preview.request.rawInputRecordId:null]);
    if (!claimed.rowCount) return this.read(userId, runId, operationId);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = prepared.kind === 'analyze' ? this.operations.analyze(savedScope, prepared.preview.request, { confirmed: true, confirmationHash: prepared.preview.confirmationHash }) : this.operations.restore(savedScope, prepared.preview.request);
      // This bounds our wait, not the provider's work. Its upload may still complete.
      const result = await Promise.race([work, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('OPERATION_EXTERNAL_DEADLINE')), this.deadlineMs);
      })]);
      await this.repo.pool.query("UPDATE memory_operations SET status='completed',result=$4,updated_at=now() WHERE user_id=$1 AND run_id=$2 AND operation_id=$3 AND status='dispatched'", [userId, runId, operationId, result]);
    } catch {
      // A thrown SDK call may already have uploaded facts. No automatic retry.
      await this.repo.pool.query("UPDATE memory_operations SET status='unknown',error_code='EXTERNAL_OUTCOME_UNKNOWN',updated_at=now() WHERE user_id=$1 AND run_id=$2 AND operation_id=$3 AND status='dispatched'", [userId, runId, operationId]);
    } finally { if (deadline !== undefined) clearTimeout(deadline); }
    return this.read(userId, runId, operationId);
  }
  async discover(userId: string, runId: string, options: { cursor?: string; limit?: number } = {}) {
    return this.operations.discover(await this.scope(await this.repo.getRun(userId, runId)), options);
  }
  /** Authenticated remote discovery/replay; deliberately does not overwrite auth, checkpoint or live SQL state. */
  async recover(userId: string, runId: string) {
    if (!this.recovery) throw new AuthorityError('EXACT_RECOVERY_NOT_CONFIGURED', 503);
    const run = await this.repo.getRun(userId, runId), scope = await this.scope(run);
    const head = await this.recovery.discover(scope);
    const recovered = await this.recovery.rebuild(scope, head.anchor, run.storyVersion);
    // New local deletions always dominate older published directory tombstones.
    const local = (await this.repo.pool.query('SELECT record_id FROM memory_tombstones WHERE user_id=$1 AND run_id=$2', [userId, runId])).rows.map(r=>r.record_id as string);
    if (local.some(id=>!recovered.tombstoneIds.includes(id))) throw new AuthorityError('RECOVERY_TOMBSTONE_HEAD_STALE');
    return { ...recovered, anchor:head.anchor, authenticatedBinding:scope.accountBindingId };
  }
}

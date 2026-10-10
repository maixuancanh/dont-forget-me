import type { MemoryReceipt } from '../domain/contracts.js';
import type { PostgresRepository } from '../persistence/repository.js';
import { transaction, AuthorityError } from '../persistence/transactions.js';
import { operationNamespace, type OperationScope } from './operations.js';
import type { MemoryRecoveryService } from './recovery.js';

/** Snapshot only acknowledged canonical records. Upload happens after the SQL snapshot releases locks. */
export async function publishRunManifest(repo: PostgresRepository, recovery: MemoryRecoveryService, scope: OperationScope) {
  const snapshot = await transaction(repo.pool,async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const run = await repo.lockedRun(c,scope.userId,scope.runId);
    if (run.revision !== scope.revision) throw new AuthorityError('REVISION_CONFLICT');
    const binding = await c.query("SELECT id,account_id FROM account_bindings WHERE id=$1 AND user_id=$2 AND network=$3 AND status='active'",[scope.accountBindingId,scope.userId,scope.network]);
    if (!binding.rowCount || (scope.accountObjectId && binding.rows[0].account_id !== scope.accountObjectId)) throw new AuthorityError('OPERATION_BINDING_UNAVAILABLE',403);
    if ((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[scope.runId])).rowCount) throw new AuthorityError('TURN_ACK_REQUIRED');
    const tombstones = (await c.query('SELECT record_id FROM memory_tombstones WHERE user_id=$1 AND run_id=$2 ORDER BY record_id',[scope.userId,scope.runId])).rows.map(r=>r.record_id as string);
    const rows = (await c.query(`SELECT m.payload_bytes,r.receipt FROM memory_records m JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id LEFT JOIN memory_receipts r ON r.record_id=m.id AND r.account_binding_id=$3 AND r.namespace=$4 AND r.state='retrievable' WHERE m.user_id=$1 AND m.run_id=$2 AND NOT EXISTS(SELECT 1 FROM memory_tombstones d WHERE d.run_id=m.run_id AND d.record_id=m.id) AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed')) ORDER BY m.sequence,m.id`,[scope.userId,scope.runId,scope.accountBindingId,operationNamespace(scope)])).rows;
    // Never publish an apparently complete head while any durable record is still uploading.
    if (rows.some(r=>!r.receipt)) throw new AuthorityError('MANIFEST_RECORD_NOT_RETRIEVABLE');
    return {storyVersion:run.storyVersion,records:rows.map(r=>({bytes:r.payload_bytes as string,receipt:r.receipt as MemoryReceipt})),tombstoneIds:tombstones};
  });
  let head: Awaited<ReturnType<MemoryRecoveryService['discover']>> | undefined;
  try { head = await recovery.discover(scope); } catch (error) { if (!(error instanceof Error) || error.message !== 'RECOVERY_DIRECTORY_UNAVAILABLE') throw error; }
  const result = await recovery.publish(scope,{...snapshot,generation:head?head.directory.generation+1:0,...(head?{previous:head.anchor}:{})});
  // Concurrent publisher forks are detected by exhaustive discover instead of hidden last-writer-wins.
  const actual = await recovery.discover(scope);
  if (actual.anchor.contentHash !== result.anchor.contentHash) throw new AuthorityError('MANIFEST_HEAD_CHANGED');
  return {...result,checkpointRestored:false as const,authRestored:false as const};
}

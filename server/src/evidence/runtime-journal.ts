import {withoutTombstones} from '../memory/tombstones.js';
import type { PostgresRepository } from '../persistence/repository.js';
import { AuthorityError } from '../persistence/transactions.js';
import { contentHash, serializeMemoryRecord } from '../domain/serialization.js';
import type { MemoryRecordV2, MemoryReceipt } from '../domain/contracts.js';
import { queryJournal, sourceCard, type JournalOptions } from './journal.js';
import { visibleEvidenceGraph, evidenceAncestors, type EvidenceEdge } from './graph.js';

export interface RuntimeJournalQuery extends JournalOptions { date?: string; currentDay?: boolean }

async function ownedLedger(repo: PostgresRepository, userId: string, runId: string) {
  const run = await repo.getRun(userId, runId);
  const result = await repo.pool.query(`SELECT m.payload,m.payload_bytes,m.content_hash,r.receipt
    FROM memory_records m
    JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id AND e.user_id=m.user_id
    LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id AND t.user_id=m.user_id
    LEFT JOIN LATERAL (SELECT receipt FROM memory_receipts WHERE record_id=m.id ORDER BY updated_at DESC,account_binding_id,namespace LIMIT 1) r ON true
    WHERE m.run_id=$1 AND m.user_id=$2 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed'))
    ORDER BY m.sequence,m.created_at,m.id`, [runId, userId]);
  const records: MemoryRecordV2[] = [], receipts: MemoryReceipt[] = [];
  const bytes = new Map<string, string>();
  for (const row of result.rows) {
    const record = row.payload as MemoryRecordV2;
    if (record.userId !== userId || record.runId !== runId) throw new AuthorityError('RECORD_SCOPE_MISMATCH', 400);
    const serialized = serializeMemoryRecord(record);
    if (row.payload_bytes !== serialized.bytes || row.content_hash !== contentHash(row.payload_bytes)) throw new AuthorityError('LOCAL_LEDGER_HASH_MISMATCH', 409);
    records.push(record); bytes.set(record.id, row.payload_bytes);
    if (row.receipt) {
      if (row.receipt.recordId !== record.id || row.receipt.contentHash !== row.content_hash) throw new AuthorityError('RECEIPT_RECORD_MISMATCH', 409);
      receipts.push(row.receipt);
    }
  }
  const admitted=await withoutTombstones(repo.pool,userId,runId,records);
  return { run, records:admitted, receipts:receipts.filter(r=>admitted.some(m=>m.id===r.recordId)), bytes:new Map([...bytes].filter(([id])=>admitted.some(r=>r.id===id))) };
}

/** Owned acknowledged ledger, including committed non-dialogue domain actions. */
export async function ownedJournal(repo: PostgresRepository, userId: string, runId: string, query: RuntimeJournalQuery = {}) {
  const ledger = await ownedLedger(repo, userId, runId);
  if (query.date) {
    const date = new Date(query.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== query.date) throw new AuthorityError('INVALID_JOURNAL_DATE', 400);
  }
  const records = query.date ? ledger.records.filter(record => record.createdAt.slice(0, 10) === query.date) : ledger.records;
  const page = queryJournal({ userId, runId }, records, ledger.receipts, { ...query, day: query.currentDay ? ledger.run.checkpoint.day : query.day });
  return { ...page, records: page.records.map(entry => {
    const card = sourceCard({ userId, runId }, ledger.records, ledger.receipts, entry.id);
    const original = card.original!;
    return { ...original, quote: original.text, speaker: original.actor, day: original.inGameDay, type: original.kind,
      status: card.receipt?.state ?? 'queued', claimStatus: original.epistemicStatus, sourceIds: original.sourceIds,
      receipt: card.receipt, blobId: card.receipt?.blobId, retracted: card.retracted, availability: card.availability };
  }) };
}

/** Exact local canonical bytes; this read does not perform or claim a new Walrus download. */
export async function ownedEvidenceSource(repo: PostgresRepository, userId: string, runId: string, recordId: string) {
  const ledger = await ownedLedger(repo, userId, runId);
  const card = sourceCard({ userId, runId }, ledger.records, ledger.receipts, recordId);
  return { ...card, canonicalBytes: ledger.bytes.get(recordId), provenance: 'local_ledger' as const, newRemoteRecall: false as const };
}

export async function ownedEvidenceGraph(repo: PostgresRepository, userId: string, runId: string, selectedIds?: string[]) {
  const ledger = await ownedLedger(repo, userId, runId), scope = { userId, runId };
  const visibleIds = selectedIds ?? ledger.records.map(record => record.id), available = new Set(ledger.records.map(record => record.id));
  const result = await repo.pool.query(`SELECT x.* FROM evidence_edges x JOIN runs r ON r.id=x.run_id WHERE x.run_id=$1 AND r.user_id=$2 ORDER BY x.id`, [runId, userId]);
  const edges: EvidenceEdge[] = result.rows.map((row): EvidenceEdge => ({ id: row.id, ...scope, fromId: row.source_id, toId: row.target_id,
    type: row.kind, sourceIds: row.payload.sourceIds ?? [row.source_id, row.target_id], cause: row.payload.cause ?? row.cause_event_id }))
    .filter(edge => available.has(edge.fromId) && available.has(edge.toId) && edge.sourceIds.every(id => available.has(id)));
  return visibleEvidenceGraph(scope, ledger.records, edges, visibleIds);
}

export async function ownedEvidenceAncestors(repo: PostgresRepository, userId: string, runId: string, recordId: string) {
  const ledger = await ownedLedger(repo, userId, runId);
  return evidenceAncestors({ userId, runId }, ledger.records, recordId, ledger.records.map(record => record.id));
}

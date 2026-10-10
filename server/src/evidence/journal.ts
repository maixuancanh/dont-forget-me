import type { MemoryReceipt, MemoryRecordV2, RecordKind, EpistemicStatus } from '../domain/contracts.js';
import { scopedRecordIndex, type EvidenceScope } from './origins.js';

export type SourceAvailability = 'available' | 'unavailable' | 'deleted';
export interface SourceCard {
  id: string; availability: SourceAvailability; retracted: boolean;
  original?: MemoryRecordV2; receipt?: MemoryReceipt;
}
export interface JournalOptions {
  query?: string; kinds?: RecordKind[]; epistemicStatuses?: EpistemicStatus[];
  actor?: MemoryRecordV2['actor']; day?: number; limit?: number; cursor?: string;
}
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US');
const terms = (query: string) => normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Append only: the original text and record identity cannot be replaced by corrections. */
export function appendJournalRecord(scope: EvidenceScope, records: readonly MemoryRecordV2[], record: MemoryRecordV2): MemoryRecordV2[] {
  const next = [...records, record];
  scopedRecordIndex(scope, next);
  if (record.sourceIds.some(id => !records.some(source => source.id === id)) || (record.supersedesId && !records.some(source => source.id === record.supersedesId))) throw new Error('APPEND_SOURCE_UNAVAILABLE');
  return structuredClone(next);
}

export function sourceCard(scope: EvidenceScope, records: readonly MemoryRecordV2[], receipts: readonly MemoryReceipt[], id: string, availability: Readonly<Record<string, SourceAvailability>> = {}): SourceCard {
  const index = scopedRecordIndex(scope, records), record = index.get(id);
  const state = availability[id] ?? (record ? 'available' : 'unavailable');
  if (state !== 'available' || !record) return { id, availability: state === 'available' ? 'unavailable' : state, retracted: false };
  const receipt = receipts.find(item => item.recordId === id);
  return { id, availability: state, retracted: records.some(item => item.supersedesId === id), original: structuredClone(record), ...(receipt ? { receipt: structuredClone(receipt) } : {}) };
}

/** Deterministic lexical natural-language search; no model or hidden propositions in ranking. */
export function queryJournal(scope: EvidenceScope, records: readonly MemoryRecordV2[], receipts: readonly MemoryReceipt[], options: JournalOptions = {}, availability: Readonly<Record<string, SourceAvailability>> = {}) {
  scopedRecordIndex(scope, records);
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_JOURNAL_LIMIT');
  const tokens = terms(options.query ?? '');
  const ordered = records.filter(record => (!options.kinds?.length || options.kinds.includes(record.kind))
    && (!options.epistemicStatuses?.length || options.epistemicStatuses.includes(record.epistemicStatus))
    && (!options.actor || options.actor === record.actor) && (options.day === undefined || options.day === record.inGameDay)
    && tokens.every(token => normalize(`${record.text} ${record.actor} ${record.kind}`).includes(token)))
    .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const cursorIndex = options.cursor ? ordered.findIndex(record => record.id === options.cursor) : -1;
  if (options.cursor && cursorIndex < 0) throw new Error('INVALID_JOURNAL_CURSOR');
  const page = ordered.slice(cursorIndex + 1, cursorIndex + 1 + limit);
  return { records: page.map(record => sourceCard(scope, records, receipts, record.id, availability)), total: ordered.length,
    nextCursor: cursorIndex + 1 + limit < ordered.length ? page.at(-1)?.id : undefined };
}

/** Prompt-safe sources contain selected exact quotes only; no roots/edges/private proposition IDs. */
export function selectedSourceQuotes(scope: EvidenceScope, records: readonly MemoryRecordV2[], selectedIds: readonly string[], permittedIds: readonly string[]) {
  const index = scopedRecordIndex(scope, records), permitted = new Set(permittedIds);
  return [...new Set(selectedIds)].map(id => {
    if (!permitted.has(id)) throw new Error('SOURCE_NOT_PERMITTED');
    const record = index.get(id); if (!record) throw new Error('SOURCE_UNAVAILABLE');
    return { id, text: record.text, actor: record.actor, epistemicStatus: record.epistemicStatus };
  });
}

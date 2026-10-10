import type { MemoryRecordV2, MemoryReceipt } from '../domain/contracts.js';
export function deletionScope(records: readonly MemoryRecordV2[], receipts: readonly MemoryReceipt[], selected: readonly string[]) {
  if (!selected.length || selected.some(id => !records.some(r => r.id === id))) throw new Error('DELETE_RECORD_UNAVAILABLE');
  const ids = new Set(selected);
  let changed = true;
  while (changed) { changed = false; for (const record of records) if (!ids.has(record.id) && [...record.sourceIds, ...record.originIds, ...(record.supersedesId ? [record.supersedesId] : [])].some(id => ids.has(id))) { ids.add(record.id); changed = true; } }
  const blobs=receipts.filter(r => ids.has(r.recordId) && r.blobId).map(r => ({ recordId: r.recordId, blobId: r.blobId!, objectId: r.objectId ?? null, accountBindingId: r.accountBindingId, network: r.network, sharedOutsideScope: receipts.some(other=>!ids.has(other.recordId)&&other.network===r.network&&(r.objectId?other.objectId===r.objectId:other.blobId===r.blobId)) })).sort((a,b) => `${a.recordId}:${a.blobId}`.localeCompare(`${b.recordId}:${b.blobId}`));
  return { recordIds: [...ids].sort(), blobs: [...new Map(blobs.map(b=>[`${b.network}:${b.objectId ?? b.blobId}`,b])).values()] };
}

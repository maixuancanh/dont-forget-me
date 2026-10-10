import type { MemoryRecordV2 } from '../domain/contracts.js';
import { scopedRecordIndex, type EvidenceScope } from './origins.js';

export type EvidenceEdgeType = 'supports' | 'contradicts' | 'derived_from' | 'disclosed_to' | 'supersedes';
export interface EvidenceEdge {
  id: string; userId: string; runId: string; fromId: string; toId: string;
  type: EvidenceEdgeType; sourceIds: string[]; cause: string;
}

export function validateEvidenceEdges(scope: EvidenceScope, records: readonly MemoryRecordV2[], edges: readonly EvidenceEdge[]): void {
  const index = scopedRecordIndex(scope, records), ids = new Set<string>();
  const lineage = new Map<string, string[]>();
  for (const record of records) lineage.set(record.id, [...record.sourceIds, ...(record.supersedesId ? [record.supersedesId] : [])]);
  for (const edge of edges) {
    if (edge.runId !== scope.runId || edge.userId !== scope.userId) throw new Error('EVIDENCE_SCOPE_MISMATCH');
    if (ids.has(edge.id)) throw new Error('DUPLICATE_EDGE_ID'); ids.add(edge.id);
    if (edge.fromId === edge.toId) throw new Error('EVIDENCE_SELF_LINK');
    if (!index.has(edge.fromId) || !index.has(edge.toId) || edge.sourceIds.some(id => !index.has(id))) throw new Error('EDGE_SOURCE_UNAVAILABLE');
    if (!edge.cause.trim() || !edge.sourceIds.length || /^(similarity|semantic_similarity)$/i.test(edge.cause.trim())) throw new Error('EDGE_CAUSE_REQUIRED');
    if (!['supports', 'contradicts', 'derived_from', 'disclosed_to', 'supersedes'].includes(edge.type)) throw new Error('INVALID_EDGE_TYPE');
    if (edge.type === 'derived_from' || edge.type === 'supersedes') {
      lineage.set(edge.fromId, [...(lineage.get(edge.fromId) ?? []), edge.toId]);
    }
  }
  const active = new Set<string>(), done = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error('EVIDENCE_CYCLE'); if (done.has(id)) return;
    active.add(id); (lineage.get(id) ?? []).forEach(visit); active.delete(id); done.add(id);
  };
  for (const id of lineage.keys()) visit(id);
}

/** Projection is an explicit allowlist, never an automatic ancestry expansion. */
export function visibleEvidenceGraph(scope: EvidenceScope, records: readonly MemoryRecordV2[], edges: readonly EvidenceEdge[], visibleIds: readonly string[]) {
  validateEvidenceEdges(scope, records, edges);
  const visible = new Set(visibleIds);
  return {
    nodes: records.filter(record => visible.has(record.id)).map(record => ({ id: record.id, kind: record.kind, epistemicStatus: record.epistemicStatus })),
    edges: edges.filter(edge => visible.has(edge.fromId) && visible.has(edge.toId) && edge.sourceIds.every(id => visible.has(id)))
      .map(edge => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, type: edge.type, sourceIds: [...edge.sourceIds], cause: edge.cause })),
  };
}

/** Ancestor IDs are returned only for a separately authorized player graph view. */
export function evidenceAncestors(scope: EvidenceScope, records: readonly MemoryRecordV2[], recordId: string, permittedIds: readonly string[]) {
  const index = scopedRecordIndex(scope, records), permitted = new Set(permittedIds);
  if (!permitted.has(recordId)) throw new Error('SOURCE_NOT_PERMITTED');
  const ancestors = new Set<string>(), unavailable = new Set<string>();
  let restrictedSourceCount = 0;
  const visit = (id: string): void => {
    if (!permitted.has(id)) { restrictedSourceCount++; return; }
    if (ancestors.has(id) || unavailable.has(id)) return;
    const record = index.get(id);
    if (!record) { unavailable.add(id); return; }
    ancestors.add(id);
    for (const source of [...record.sourceIds, ...(record.supersedesId ? [record.supersedesId] : [])]) visit(source);
  };
  visit(recordId);
  ancestors.delete(recordId);
  return { ancestorIds: [...ancestors].sort(), unavailableIds: [...unavailable].sort(), restrictedSourceCount };
}

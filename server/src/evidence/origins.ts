import type { MemoryRecordV2 } from '../domain/contracts.js';
import { propositions } from '../story/canon.js';

export interface EvidenceScope { userId: string; runId: string }
export interface OriginLineage { rootIds: string[]; unavailableIds: string[]; complete: boolean }

/** Scope is mandatory even for pure helpers: callers must supply their authenticated owner. */
export function scopedRecordIndex(scope: EvidenceScope, records: readonly MemoryRecordV2[]): Map<string, MemoryRecordV2> {
  const index = new Map<string, MemoryRecordV2>();
  for (const record of records) {
    if (record.userId !== scope.userId || record.runId !== scope.runId) throw new Error('EVIDENCE_SCOPE_MISMATCH');
    if (index.has(record.id)) throw new Error('DUPLICATE_EVIDENCE_ID');
    index.set(record.id, record);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('EVIDENCE_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    const record = index.get(id);
    for (const source of [...(record?.sourceIds ?? []), ...(record?.supersedesId ? [record.supersedesId] : [])]) visit(source);
    visiting.delete(id); visited.add(id);
  };
  for (const id of index.keys()) visit(id);
  return index;
}

/** Only actual witness/observation records seed roots. Missing sources never fabricate roots. */
export function resolveOrigins(scope: EvidenceScope, records: readonly MemoryRecordV2[], recordId: string): OriginLineage {
  const index = scopedRecordIndex(scope, records);
  const roots = new Set<string>(), unavailable = new Set<string>();
  const visit = (id: string) => {
    const record = index.get(id);
    if (!record) { unavailable.add(id); return; }
    if (record.sourceIds.length) { record.sourceIds.forEach(visit); return; }
    const authored = record.propositionIds.map(propositionId => propositions.find(proposition => proposition.id === propositionId)).filter(item => item !== undefined);
    // Canon explicitly marks hearsay explanations; another actor repeating the
    // same authored claim without its source link cannot seed a new witness.
    const eligibleAuthored = authored.length === 0 || authored.some(proposition => proposition.owner === record.actor
      && !proposition.clueTags.some(tag => ['rumor', 'hearsay', 'hearsay_explanation', 'confession'].includes(tag))
      && proposition.disclosure !== 'never_prompt');
    if (eligibleAuthored && (record.kind === 'utterance' || record.kind === 'conversation' || record.kind === 'observation')) roots.add(id);
  };
  visit(recordId);
  return { rootIds: [...roots].sort(), unavailableIds: [...unavailable].sort(), complete: unavailable.size === 0 };
}

export function assessIndependence(scope: EvidenceScope, records: readonly MemoryRecordV2[], recordIds: readonly string[]) {
  const lineages = [...new Set(recordIds)].map(id => ({ recordId: id, ...resolveOrigins(scope, records, id) }));
  const roots = [...new Set(lineages.flatMap(item => item.rootIds))].sort();
  const sharedRootIds = roots.filter(root => lineages.filter(item => item.rootIds.includes(root)).length > 1);
  // Two copied accounts do not become independent merely by changing speakers.
  const independent = lineages.length >= 2 && lineages.every(item => item.complete && item.rootIds.length > 0)
    && sharedRootIds.length === 0;
  return { independent, independentOriginCount: roots.length, rootIds: roots, sharedRootIds, lineages };
}

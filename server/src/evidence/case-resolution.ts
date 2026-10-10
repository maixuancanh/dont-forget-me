import type { MemoryRecordV2, MemoryReceipt, NpcId } from '../domain/contracts.js';
import { serializeMemoryRecord } from '../domain/serialization.js';
import { beats, propositions, contradictions, endings, STORY_VERSION } from '../story/canon.js';
import { resolveOrigins, scopedRecordIndex, type EvidenceScope } from './origins.js';

export interface EvidenceReviewScope extends EvidenceScope { day: number; accountBindingId: string; namespace: string; network: MemoryReceipt['network'] }
export interface DisclosureKnowledge extends EvidenceScope { recordId: string; recipient: NpcId }
export interface CaseReviewInput { scope: EvidenceReviewScope; records: readonly MemoryRecordV2[]; receipts: readonly MemoryReceipt[]; selectedIds: readonly string[]; disclosures: readonly DisclosureKnowledge[] }
const labels: Record<string, string> = { debt_paid: 'A source confirming payment', duplicate_debt: 'A source showing the duplicate entry', incident_witness: 'Testimony connecting the incident', corroboration: 'Independent corroboration', identity: 'Confirmed identification' };

/** Canonical record propositions describe attributed evidence, never prove world guilt. */
function categories(record: MemoryRecordV2, day: number): string[] {
  if (record.storyVersion !== STORY_VERSION || record.inGameDay > day || !['utterance', 'observation'].includes(record.kind)) return [];
  const beat = beats.find(item => item.beatId === record.beatId);
  if (!beat || beat.day > day) return [];
  return [...new Set(record.propositionIds.flatMap(id => {
    const proposition = propositions.find(item => item.id === id);
    if (!proposition || !beat.propositionIds.includes(id) || proposition.owner !== record.actor || proposition.minimumDay > day
      || proposition.disclosure === 'never_prompt' || proposition.revealConditions.serverPrivate
      || proposition.epistemicStatus !== record.epistemicStatus) return [];
    return proposition.clueTags;
  }))];
}
function ready(record: MemoryRecordV2, receipts: readonly MemoryReceipt[], scope: EvidenceReviewScope): boolean {
  const hash = serializeMemoryRecord(record).contentHash;
  return receipts.some(receipt => receipt.recordId === record.id && receipt.accountBindingId === scope.accountBindingId
    && receipt.namespace === scope.namespace && receipt.network === scope.network && receipt.state === 'retrievable'
    && receipt.contentHash === hash && Boolean(receipt.blobId && receipt.verifiedAt && receipt.lastRecallAt));
}
function selected(input: Omit<CaseReviewInput, 'disclosures'>) {
  const index = scopedRecordIndex(input.scope, input.records);
  if (!Number.isInteger(input.scope.day) || input.scope.day < 1 || input.scope.day > 6) throw new Error('INVALID_REVIEW_DAY');
  if (new Set(input.selectedIds).size !== input.selectedIds.length || input.selectedIds.length > 30) throw new Error('INVALID_EVIDENCE_SELECTION');
  const rows = input.selectedIds.map(id => index.get(id));
  const pendingIds = input.selectedIds.filter((id, position) => !rows[position] || !ready(rows[position]!, input.receipts, input.scope));
  return { index, rows: rows.filter((row): row is MemoryRecordV2 => Boolean(row)), pendingIds };
}

/** Authored contradictions only; the result opens a question and never supplies NPC dialogue. */
export function compareEvidence(input: Omit<CaseReviewInput, 'disclosures'>) {
  if (input.selectedIds.length !== 2) throw new Error('SELECT_TWO_SOURCES');
  const selection = selected(input);
  if (selection.pendingIds.length) return { state: 'pending' as const, sourceIds: [...input.selectedIds], pendingIds: selection.pendingIds, matchedRuleIds: [] as string[], unlockQuestions: [] as string[], explanations: [] as string[] };
  const [a, b] = selection.rows;
  const tags = [categories(a, input.scope.day), categories(b, input.scope.day)];
  const legacyIds = [a, b].map(record => {
    const beat = beats.find(item => item.beatId === record.beatId);
    // A beat label is insufficient: the authentic record must express its authorized propositions.
    return beat && record.propositionIds.some(id => beat.propositionIds.includes(id) && propositions.some(p => p.id === id && p.owner === record.actor && p.minimumDay <= input.scope.day && p.disclosure !== 'never_prompt')) ? beat.legacyEventId : undefined;
  });
  const eligible = [a, b].every(record => ['utterance', 'observation'].includes(record.kind) && record.storyVersion === STORY_VERSION && record.inGameDay <= input.scope.day);
  const matches = eligible && a.eventId !== b.eventId ? contradictions.filter(rule => input.scope.day >= rule.minimumDay && (rule.requiredEventIds
    ? rule.requiredEventIds.every(id => legacyIds.includes(id))
    : rule.requiredTags?.length === 2 && ((tags[0].includes(rule.requiredTags[0]) && tags[1].includes(rule.requiredTags[1])) || (tags[1].includes(rule.requiredTags[0]) && tags[0].includes(rule.requiredTags[1]))))) : [];
  return { state: 'ready' as const, supported: matches.length > 0, sourceIds: [...input.selectedIds], matchedRuleIds: matches.map(rule => rule.id), unlockQuestions: matches.map(rule => rule.unlocksQuestion), explanations: matches.map(rule => rule.explanation) };
}

export function resolveCase(input: CaseReviewInput) {
  if (input.scope.day < endings.minimumDay) throw new Error('CASE_REVIEW_NOT_OPEN');
  const selection = selected(input);
  const pending = new Set(selection.pendingIds);
  const eligible = selection.rows.filter(record => {
    const tags = categories(record, input.scope.day);
    return tags.some(tag => endings.resolved.requiredTags.includes(tag)) && !tags.some(tag => endings.resolved.excludeTags.includes(tag));
  });
  const roots = new Set<string>();
  for (const record of eligible) {
    const lineage = resolveOrigins(input.scope, input.records, record.id);
    for (const id of lineage.unavailableIds) pending.add(id);
    for (const id of lineage.rootIds) {
      const root = selection.index.get(id)!;
      if (!ready(root, input.receipts, input.scope)) pending.add(id);
      else if (categories(root, input.scope.day).some(tag => endings.resolved.requiredTags.includes(tag))) roots.add(id);
    }
  }
  if (pending.size) return { outcome: 'pending' as const, missing: ['Selected source verification is pending'], pendingIds: [...pending].sort(), sourceIds: [...input.selectedIds], canContinue: true, canRetry: true };
  const tags = new Set(eligible.flatMap(record => categories(record, input.scope.day)));
  const missing = endings.resolved.requiredTags.filter(tag => !tags.has(tag)).map(tag => labels[tag] ?? tag);
  // Multiple statements from the same witness remain a single independent account.
  const independentOriginCount = new Set([...roots].map(id => selection.index.get(id)!.actor)).size;
  if (independentOriginCount < endings.resolved.minimumIndependentSpeakers) missing.push('Three independent sources');
  if (input.selectedIds.some(id => !input.disclosures.some(knowledge => knowledge.userId === input.scope.userId && knowledge.runId === input.scope.runId && knowledge.recordId === id && knowledge.recipient === endings.resolved.requireSharedWith))) missing.push('Report each selected source to Phuc');
  return { outcome: missing.length ? 'unresolved' as const : 'resolved' as const, missing, independentOriginCount, sourceIds: [...input.selectedIds], canContinue: missing.length > 0, canRetry: false };
}

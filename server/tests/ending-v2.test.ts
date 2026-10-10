import { it, expect } from 'vitest';
import type { MemoryRecordV2, MemoryReceipt } from '../src/domain/contracts.js';
import { beats, propositions, STORY_VERSION } from '../src/story/canon.js';
import { serializeMemoryRecord } from '../src/domain/serialization.js';
import { compareEvidence, resolveCase, type CaseReviewInput } from '../src/evidence/case-resolution.js';
import { resolveOrigins } from '../src/evidence/origins.js';
const scope = { userId: 'u', runId: 'r', day: 6, accountBindingId: 'binding', namespace: 'ns', network: 'local' as const };
function authored(propositionId: string, id = propositionId, extra: Partial<MemoryRecordV2> = {}): MemoryRecordV2 {
  const proposition = propositions.find(item => item.id === propositionId)!;
  const beat = beats.find(item => item.propositionIds.includes(propositionId))!;
  return { schemaVersion: 2, id, eventId: `event-${id}`, userId: 'u', runId: 'r', sessionId: 's', sequence: 1, storyVersion: STORY_VERSION, beatId: beat.beatId, inGameDay: proposition.minimumDay, createdAt: '2026-10-09T00:00:00Z', actor: proposition.owner as MemoryRecordV2['actor'], kind: proposition.epistemicStatus === 'observed' ? 'observation' : 'utterance', epistemicStatus: proposition.epistemicStatus as MemoryRecordV2['epistemicStatus'], text: proposition.meaning, sourceIds: [], originIds: [id], recipients: ['player'], entityIds: [], propositionIds: [propositionId], ...extra };
}
const receipt = (record: MemoryRecordV2): MemoryReceipt => ({ recordId: record.id, accountBindingId: 'binding', namespace: 'ns', network: 'local', state: 'retrievable', blobId: `blob-${record.id}`, contentHash: serializeMemoryRecord(record).contentHash, verifiedAt: '2026-10-09T00:00:00Z', lastRecallAt: '2026-10-09T00:00:00Z' });
function input(records = [authored('p.ledger'), authored('p.Day6_1_Carlo.11'), authored('p.Day6_2_Mario.0'), authored('p.Day6_3_Jomar.10')]): CaseReviewInput {
  return { scope, records, receipts: records.map(receipt), selectedIds: records.map(record => record.id), disclosures: records.map(record => ({ userId: 'u', runId: 'r', recordId: record.id, recipient: 'phuc' })) };
}
it('resolves attributed independent canonical categories without requiring confession or returning hidden facts', () => {
  const result = resolveCase(input());
  expect(result).toMatchObject({ outcome: 'resolved', missing: [], independentOriginCount: 4 });
  expect(JSON.stringify(result)).not.toContain('truth.'); expect(JSON.stringify(result)).not.toContain('guilt');
});
it('preserves pending verification as retryable and checks receipt hash, binding and lineage', () => {
  const evidence = input(); evidence.receipts = evidence.receipts.slice(1);
  expect(resolveCase(evidence)).toMatchObject({ outcome: 'pending', canRetry: true });
  const wrong = input(); wrong.receipts = wrong.receipts.map(item => ({ ...item, accountBindingId: 'foreign' }));
  expect(resolveCase(wrong).outcome).toBe('pending');
  const hash = input(); hash.receipts = hash.receipts.map(item => ({ ...item, contentHash: 'bad' }));
  expect(resolveCase(hash).outcome).toBe('pending');
  const lineage = input(); lineage.records = lineage.records.map(record => record.id === 'p.Day6_1_Carlo.11' ? { ...record, sourceIds: ['missing-original'] } : record); lineage.receipts = lineage.records.map(receipt);
  expect(resolveCase(lineage)).toMatchObject({ outcome: 'pending', pendingIds: ['missing-original'] });
});
it('requires every selected source to be shown to Phuc within the same owned run', () => {
  const evidence = input(); evidence.disclosures = evidence.disclosures.map(item => ({ ...item, runId: 'other' }));
  expect(resolveCase(evidence)).toMatchObject({ outcome: 'unresolved', missing: ['Report each selected source to Phuc'] });
});
it('does not promote hypotheses, aliases or private answer propositions to canonical evidence', () => {
  const records = input().records.map(record => ({ ...record, kind: 'hypothesis' as const, epistemicStatus: 'hypothesized' as const, actor: 'player' as const }));
  const result = resolveCase(input(records)); expect(result.outcome).toBe('unresolved');
  expect(result.missing).toContain('A source confirming payment');
  const alias = authored('p.ledger', 'alias', { kind: 'alias', actor: 'player', propositionIds: ['truth.identity_day6'], text: 'confession' });
  expect(resolveCase(input([alias])).outcome).toBe('unresolved');
  expect(JSON.stringify(resolveCase(input([alias])))).not.toContain('truth.identity_day6');
});
it('deduplicates same witnesses and shared rumor roots rather than counting repeated speakers', () => {
  const root = authored('p.Day6_1_Carlo.11', 'root');
  const copies = [root, authored('p.Day6_1_Carlo.11', 'repeat', { sourceIds: ['root'], originIds: ['invented'] }), authored('p.Day6_2_Mario.0', 'retelling', { sourceIds: ['root'], originIds: ['invented-second'] })];
  const result = resolveCase(input(copies)); expect(result).toMatchObject({ outcome: 'unresolved', independentOriginCount: 1 });
  const sameWitness = [root, authored('p.duy.trusted', 'second')];
  expect(resolveCase(input(sameWitness))).toMatchObject({ independentOriginCount: 1 });
  const rumor = authored('p.Day5_3_Lucia.8', 'rumor');
  expect(resolveOrigins(scope, [rumor], 'rumor').rootIds).toEqual([]);
  const unlinkedCopy = authored('p.Day6_1_Carlo.11', 'unlinked', { actor: 'sau' });
  expect(resolveOrigins(scope, [unlinkedCopy], 'unlinked').rootIds).toEqual([]);
});
it('compares authored tag and legacy-event rules at the permitted day with structural results only', () => {
  const pair = input([authored('p.Day2_1_Junjun.4'), authored('p.ledger')]);
  const result = compareEvidence(pair); expect(result.matchedRuleIds).toContain('ledger_confirms_duplicate');
  expect(result.unlockQuestions).toContain('Why was the paid loan entered again?');
  expect(result).not.toHaveProperty('npcResponse');
  const earlier = input([authored('p.Day2_1_Junjun.4'), authored('p.Day3_1_Junjun.4')]);
  expect(compareEvidence({ ...earlier, scope: { ...scope, day: 3 } }).matchedRuleIds).toEqual(['paid_then_reentered']);
  expect(compareEvidence({ ...earlier, scope: { ...scope, day: 2 } }).matchedRuleIds).toEqual([]);
  expect(compareEvidence({ ...earlier, receipts: [] }).state).toBe('pending');
});
it('rejects cycles, foreign records, duplicate selections and early review', () => {
  const evidence = input();
  expect(() => resolveCase({ ...evidence, scope: { ...scope, day: 5 } })).toThrow('NOT_OPEN');
  expect(() => resolveCase({ ...evidence, selectedIds: [evidence.selectedIds[0], evidence.selectedIds[0]] })).toThrow('SELECTION');
  expect(() => resolveCase({ ...evidence, records: evidence.records.map(record => ({ ...record, runId: 'foreign' })) })).toThrow('SCOPE');
  expect(() => resolveCase(input([authored('p.ledger', 'cycle', { sourceIds: ['cycle'] })]))).toThrow('CYCLE');
});

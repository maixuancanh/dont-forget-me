import { describe, expect, it } from 'vitest';
import type { MemoryRecordV2, MemoryReceipt } from '../src/domain/contracts.js';
import { assessIndependence, resolveOrigins } from '../src/evidence/origins.js';
import { evidenceAncestors, validateEvidenceEdges, visibleEvidenceGraph, type EvidenceEdge } from '../src/evidence/graph.js';
import { appendJournalRecord, queryJournal, selectedSourceQuotes, sourceCard } from '../src/evidence/journal.js';

const scope = { userId: 'u', runId: 'run' };
const record = (id: string, extra: Partial<MemoryRecordV2> = {}): MemoryRecordV2 => ({ schemaVersion: 2, id, eventId: `e-${id}`, ...scope, sessionId: 's', sequence: 1, storyVersion: 'v', beatId: 'b', inGameDay: 1, createdAt: '2026-10-09T00:00:00Z', actor: 'binh', kind: 'utterance', text: 'I saw the blue truck', epistemicStatus: 'said', sourceIds: [], originIds: [id], recipients: ['player'], entityIds: [], propositionIds: ['private-answer'], ...extra });
const edge = (extra: Partial<EvidenceEdge> = {}): EvidenceEdge => ({ id: 'edge', ...scope, fromId: 'copy', toId: 'root', type: 'derived_from', sourceIds: ['root'], cause: 'acknowledged retelling', ...extra });

describe('P18 deterministic evidence', () => {
  it('traces multi-tier rumors and never trusts fabricated origin IDs or distinct speakers', () => {
    const records = [record('root'), record('copy', { sourceIds: ['root'], originIds: ['forged'], actor: 'hanh' }), record('third', { sourceIds: ['copy'], actor: 'bao' })];
    expect(resolveOrigins(scope, records, 'third').rootIds).toEqual(['root']);
    expect(assessIndependence(scope, records, ['copy', 'third'])).toMatchObject({ independent: false, independentOriginCount: 1, sharedRootIds: ['root'] });
    expect(assessIndependence(scope, [...records, record('witness', { kind: 'observation', epistemicStatus: 'observed' })], ['copy', 'witness']).independent).toBe(true);
    expect(resolveOrigins(scope, [record('guess', { kind: 'hypothesis', epistemicStatus: 'hypothesized' })], 'guess').rootIds).toEqual([]);
  });
  it('reports missing ancestors explicitly without counting them as independent witnesses', () => {
    const records = [record('copy', { sourceIds: ['missing'] }), record('other')];
    expect(resolveOrigins(scope, records, 'copy')).toEqual({ rootIds: [], unavailableIds: ['missing'], complete: false });
    expect(assessIndependence(scope, records, ['copy', 'other']).independent).toBe(false);
  });
  it('rejects self links, cycles, duplicate IDs and foreign scopes', () => {
    expect(() => resolveOrigins(scope, [record('root', { sourceIds: ['root'] })], 'root')).toThrow('EVIDENCE_CYCLE');
    expect(() => resolveOrigins(scope, [record('a', { sourceIds: ['b'] }), record('b', { sourceIds: ['a'] })], 'a')).toThrow('EVIDENCE_CYCLE');
    expect(() => resolveOrigins(scope, [record('root'), record('root')], 'root')).toThrow('DUPLICATE');
    expect(() => resolveOrigins(scope, [record('root', { runId: 'foreign' })], 'root')).toThrow('SCOPE');
    expect(() => resolveOrigins(scope, [record('root', { userId: 'other' })], 'root')).toThrow('SCOPE');
  });
  it('requires typed causal evidence and checks combined record/edge cycles', () => {
    const records = [record('root'), record('copy', { sourceIds: ['root'] })];
    expect(() => validateEvidenceEdges(scope, records, [edge()])).not.toThrow();
    expect(() => validateEvidenceEdges(scope, records, [edge({ cause: 'similarity' })])).toThrow('CAUSE');
    expect(() => validateEvidenceEdges(scope, records, [edge({ fromId: 'root', toId: 'copy' })])).toThrow('CYCLE');
    expect(() => validateEvidenceEdges(scope, records, [edge({ toId: 'copy' })])).toThrow('SELF_LINK');
    expect(() => validateEvidenceEdges(scope, records, [edge({ sourceIds: ['foreign'] })])).toThrow('UNAVAILABLE');
    expect(() => validateEvidenceEdges(scope, records, [edge({ runId: 'foreign' })])).toThrow('SCOPE');
  });
  it('retains exact retracted originals and receipts via append-only corrections', () => {
    const original = record('root');
    const records = appendJournalRecord(scope, [original], record('correction', { kind: 'correction', supersedesId: 'root', sourceIds: ['root'], text: 'Actually red', sequence: 2 }));
    const receipt: MemoryReceipt = { recordId: 'root', accountBindingId: 'binding', namespace: 'namespace', network: 'local', state: 'retrievable', contentHash: 'hash' };
    const card = sourceCard(scope, records, [receipt], 'root');
    expect(card).toMatchObject({ retracted: true, original: { text: original.text }, receipt });
    card.original!.text = 'mutated'; expect(records[0].text).toBe(original.text);
    expect(() => appendJournalRecord(scope, records, original)).toThrow('DUPLICATE');
    expect(() => appendJournalRecord(scope, records, record('bad', { sourceIds: ['missing'] }))).toThrow('UNAVAILABLE');
  });
  it('uses explicit deleted/unavailable cards without exposing cached text', () => {
    expect(sourceCard(scope, [record('root')], [], 'root', { root: 'deleted' })).toEqual({ id: 'root', availability: 'deleted', retracted: false });
    expect(sourceCard(scope, [], [], 'missing')).toEqual({ id: 'missing', availability: 'unavailable', retracted: false });
  });
  it('searches human text with stable paging, filters and epistemic labels', () => {
    const records = [record('b', { sequence: 2, text: 'I saw café blue', kind: 'observation', epistemicStatus: 'observed' }), record('a', { sequence: 1, text: 'A blue truck' }), record('c', { sequence: 3, text: 'Blue rumor' })];
    expect(queryJournal(scope, records, [], { query: 'cafe blue', kinds: ['observation'] }).records.map(card => card.id)).toEqual(['b']);
    const first = queryJournal(scope, records, [], { query: 'blue', limit: 2 }); expect(first.nextCursor).toBe('b');
    expect(queryJournal(scope, records, [], { query: 'blue', limit: 2, cursor: first.nextCursor }).records.map(card => card.id)).toEqual(['c']);
    expect(queryJournal(scope, records, [], { epistemicStatuses: ['observed'] }).records[0].original?.epistemicStatus).toBe('observed');
    expect(() => queryJournal(scope, records, [], { cursor: 'foreign' })).toThrow('CURSOR');
    expect(() => queryJournal(scope, records, [], { limit: 0 })).toThrow('LIMIT');
  });
  it('never expands permitted sources into private ancestry or prompt propositions', () => {
    const records = [record('root', { text: 'Secret origin' }), record('copy', { sourceIds: ['root'], text: 'Selected quote' })];
    expect(visibleEvidenceGraph(scope, records, [edge()], ['copy'])).toEqual({ nodes: [{ id: 'copy', kind: 'utterance', epistemicStatus: 'said' }], edges: [] });
    expect(selectedSourceQuotes(scope, records, ['copy'], ['copy'])).toEqual([{ id: 'copy', text: 'Selected quote', actor: 'binh', epistemicStatus: 'said' }]);
    expect(() => selectedSourceQuotes(scope, records, ['root'], ['copy'])).toThrow('NOT_PERMITTED');
    expect(evidenceAncestors(scope, records, 'copy', ['copy'])).toEqual({ ancestorIds: [], unavailableIds: [], restrictedSourceCount: 1 });
    expect(evidenceAncestors(scope, records, 'copy', ['copy', 'root']).ancestorIds).toEqual(['root']);
  });
});

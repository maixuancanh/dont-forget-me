import type { State, RecordEntry } from "../model.js";
import { NPC_IDS, type MemoryRecordV2, type MemoryReceipt, type WriteState } from "../domain/contracts.js";
import { memoryRecordV2Schema, memoryReceiptSchema } from "../domain/schemas.js";
import { canonicalSerialize, contentHash, serializeMemoryRecord } from "../domain/serialization.js";
import { legacyMappings } from "../story/canon.js";
export interface MigrationOptions { bindings?: Record<string,{accountBindingId:string;namespace:string;network:"local"|"mainnet"}> }
export interface MigratedEntry {
  record: MemoryRecordV2; bytes:string; contentHash:string;
  legacy: { entry: RecordEntry; storyVersion:string; mapping:"authored"|"dynamic"; originalNamespace:string; representationKey:string; originalBytes?:string; originalContentHash?:string; originalBlobId?:string; originalJobId?:string; receiptState:WriteState; unresolvedProvenance:string[] };
  receipt?:MemoryReceipt;
}
export interface MigrationV2 { schemaVersion:2; migrationId:"record-entry-v1-to-v2"; originalState:unknown; originalStateHash:string; bindingSnapshot:NonNullable<MigrationOptions["bindings"]>; bindingSnapshotHash:string; runs:Record<string,{records:MigratedEntry[]}> }
export type MigratableState = State & { memoryV2?:MigrationV2 };
const clone = <T>(v:T):T => JSON.parse(JSON.stringify(v));
const participant = (v:string): v is typeof NPC_IDS[number]|"player" => v === "player" || (NPC_IDS as readonly string[]).includes(v);
function taxonomy(type:string): Pick<MemoryRecordV2,"kind"|"epistemicStatus"> {
  if(type === "share") return {kind:"disclosure",epistemicStatus:"said"};
  if(type === "claim") return {kind:"utterance",epistemicStatus:"said"};
  if(type === "observation") return {kind:"observation",epistemicStatus:"observed"};
  if(type === "conversation") return {kind:"conversation",epistemicStatus:"said"};
  if(type === "hypothesis") return {kind:"hypothesis",epistemicStatus:"hypothesized"};
  const kinds = ["promise","relationship","disclosure","comparison","task","alias","interpretation","outcome","manifest"];
  return {kind:kinds.includes(type) ? type as MemoryRecordV2["kind"] : "utterance",epistemicStatus:"said"};
}
/** Pure and explicit: never opens a store, a provider, or a database. */
export function migrateV1ToV2(state:MigratableState, options:MigrationOptions = {}):MigratableState {
  if(state.memoryV2) { validateMigration(state.memoryV2); assertUnchangedProjection(state); return clone(state); }
  const output = clone(state);
  const bindingSnapshot=clone(options.bindings??{});
  const migration:MigrationV2 = {schemaVersion:2,migrationId:"record-entry-v1-to-v2",originalState:clone(state),originalStateHash:contentHash(canonicalSerialize(state)),bindingSnapshot,bindingSnapshotHash:contentHash(canonicalSerialize(bindingSnapshot)),runs:{}};
  for(const [runKey,run] of Object.entries(state.runs)) {
    if(runKey !== run.id || !state.users[run.userId] || state.users[run.userId]!.id !== run.userId) throw new Error("Invalid legacy owner/run scope");
    const byId = new Map<string,RecordEntry>(); const events = new Set<string>();
    for(const r of run.records) {if(r.runId !== run.id || byId.has(r.id) || events.has(r.eventId)) throw new Error("Invalid or duplicate legacy record/event scope"); byId.set(r.id,r);events.add(r.eventId);}
    const origins = (recordId:string, visiting = new Set<string>()):string[] => {
      if(visiting.has(recordId)) throw new Error("Source cycle");
      const r = byId.get(recordId); if(!r) throw new Error("Foreign or missing source");
      if(!r.sourceIds.length) return [r.id];
      const next = new Set(visiting).add(recordId);
      return [...new Set(r.sourceIds.flatMap(id=>origins(id,next)))];
    };
    const records = run.records.map((r,sequence):MigratedEntry => {
      const mapping = legacyMappings.find(m=>m.legacyEventId === r.eventId);
      const actor = participant(r.speaker) || r.speaker === "system" ? r.speaker : "system";
      if(r.recipients.some(v=>!participant(v))) throw new Error("Unknown legacy recipient");
      const record = memoryRecordV2Schema.parse({schemaVersion:2,id:r.id,eventId:r.eventId,userId:run.userId,runId:run.id,sessionId:`legacy-session:${run.id}`,sequence,storyVersion:mapping?.legacyStoryVersion ?? "legacy-v1",beatId:mapping?.beatId ?? `legacy-dynamic:${r.eventId}`,inGameDay:r.day,createdAt:r.createdAt,actor,...taxonomy(r.type),text:r.quote,sourceIds:[...new Set(r.sourceIds)],originIds:origins(r.id),recipients:[...new Set(r.recipients)],entityIds:[],propositionIds:mapping?.propositionIds ?? []});
      const serialized = serializeMemoryRecord(record);
      const binding = options.bindings?.[run.id];
      // Exact v1 scope formula from memory.ts; no provider SDK initialization.
      const originalNamespace=`dfm:v1:${run.userId}:${run.id}:case`;
      const originalBytes = state.localMemories[originalNamespace]?.find(m=>m.blob_id === r.blobId)?.text;
      const receiptState:WriteState = r.status === "confirmed" && r.blobId ? "indexed" : r.status === "failed" ? "retryable_failure" : "queued";
      const unresolvedProvenance:string[] = [];
      if(!["share","claim","observation","conversation","hypothesis","promise","relationship","disclosure","comparison","task","alias","interpretation","outcome","manifest"].includes(r.type)) unresolvedProvenance.push("legacy_taxonomy_unresolved");
      if(!r.network) unresolvedProvenance.push("missing_network");
      if(!binding) unresolvedProvenance.push("missing_account_binding");
      if(originalBytes === undefined) unresolvedProvenance.push("original_payload_unavailable");
      if(r.status === "confirmed" && !r.blobId) unresolvedProvenance.push("confirmation_missing_blob");
      if(originalBytes !== undefined) {
        try {const old=JSON.parse(originalBytes);if(old.recordId !== r.id || old.runId !== run.id || old.eventId !== r.eventId) unresolvedProvenance.push("original_payload_scope_mismatch");}
        catch {unresolvedProvenance.push("original_payload_invalid_json");}
      }
      const legacy:MigratedEntry["legacy"] = {entry:clone(r),storyVersion:record.storyVersion,mapping:mapping?"authored":"dynamic",originalNamespace,representationKey:`v2:${r.id}:${serialized.contentHash}`,receiptState,unresolvedProvenance};
      if(r.blobId) legacy.originalBlobId=r.blobId; if(r.jobId) legacy.originalJobId=r.jobId;
      if(originalBytes !== undefined) {legacy.originalBytes=originalBytes;legacy.originalContentHash=contentHash(originalBytes);}
      // Existing blob/job refer to v1 bytes. They must never be attached to v2 bytes.
      const entry:MigratedEntry = {record,...serialized,legacy};
      if(binding && r.network && binding.network === r.network) entry.receipt = memoryReceiptSchema.parse({recordId:r.id,...binding,state:"queued",contentHash:serialized.contentHash});
      else if(binding && r.network) legacy.unresolvedProvenance.push("binding_network_mismatch");
      return entry;
    });
    migration.runs[runKey]={records};
  }
  validateMigration(migration); output.memoryV2=migration; return output;
}
export function validateMigration(migration:MigrationV2):void {
  if(migration.schemaVersion !== 2 || migration.migrationId !== "record-entry-v1-to-v2") throw new Error("Unsupported migration version");
  if(contentHash(canonicalSerialize(migration.originalState)) !== migration.originalStateHash) throw new Error("Original snapshot hash mismatch");
  const original=migration.originalState as State;
  if(contentHash(canonicalSerialize(migration.bindingSnapshot))!==migration.bindingSnapshotHash)throw new Error("Binding snapshot hash mismatch");
  if(canonicalSerialize(Object.keys(migration.runs).sort()) !== canonicalSerialize(Object.keys(original.runs).sort())) throw new Error("Migration run scope mismatch");
  for(const [runKey,run] of Object.entries(migration.runs)) {
    const oldRun=original.runs[runKey]!;
    if(oldRun.id !== runKey || !original.users[oldRun.userId] || oldRun.records.length !== run.records.length) throw new Error("Migration history or owner mismatch");
    const ids = new Set(run.records.map(e=>e.record.id));
    if(ids.size !== run.records.length) throw new Error("Duplicate logical ID");
    const lineage = (id:string, path = new Set<string>()):string[] => {
      if(path.has(id)) throw new Error("Source cycle");
      const entry=run.records.find(e=>e.record.id === id); if(!entry) throw new Error("Foreign or missing provenance");
      if(!entry.record.sourceIds.length) return [id];
      return [...new Set(entry.record.sourceIds.flatMap(source=>lineage(source,new Set(path).add(id))))];
    };
    for(const [sequence,e] of run.records.entries()) {
      const record = memoryRecordV2Schema.parse(e.record); const serialized = serializeMemoryRecord(record);
      const old=oldRun.records[sequence]!;
      if(record.id !== old.id || record.eventId !== old.eventId || record.runId !== oldRun.id || record.userId !== oldRun.userId || record.sequence !== sequence || record.text !== old.quote || record.inGameDay !== old.day || canonicalSerialize(e.legacy.entry) !== canonicalSerialize(old)) throw new Error("Migration history or owner mismatch");
      const mapping=legacyMappings.find(m=>m.legacyEventId === old.eventId);
      const expectedActor=participant(old.speaker) || old.speaker === "system" ? old.speaker : "system";
      const expectedTaxonomy=taxonomy(old.type);
      const expectedNamespace=`dfm:v1:${oldRun.userId}:${oldRun.id}:case`;
      const expectedBytes=original.localMemories[expectedNamespace]?.find(m=>m.blob_id === old.blobId)?.text;
      const expectedState=old.status === "confirmed" && old.blobId ? "indexed" : old.status === "failed" ? "retryable_failure" : "queued";
      const selectedBinding=migration.bindingSnapshot[runKey];
      const receiptExpected=!!selectedBinding&&!!old.network&&selectedBinding.network===old.network;
      if(Boolean(e.receipt)!==receiptExpected||e.receipt&&(e.receipt.accountBindingId!==selectedBinding?.accountBindingId||e.receipt.namespace!==selectedBinding?.namespace||e.receipt.network!==selectedBinding?.network))throw new Error("Receipt binding snapshot mismatch");
      if(e.legacy.originalNamespace !== expectedNamespace || e.legacy.originalBlobId !== old.blobId || e.legacy.originalJobId !== old.jobId || e.legacy.receiptState !== expectedState || e.legacy.storyVersion !== (mapping?.legacyStoryVersion ?? "legacy-v1") || e.legacy.mapping !== (mapping?"authored":"dynamic") || e.legacy.originalBytes !== expectedBytes || e.legacy.originalContentHash !== (expectedBytes === undefined?undefined:contentHash(expectedBytes))) throw new Error("Legacy proof snapshot mismatch");
      if(record.createdAt !== old.createdAt || record.actor !== expectedActor || record.kind !== expectedTaxonomy.kind || record.epistemicStatus !== expectedTaxonomy.epistemicStatus || record.sessionId !== `legacy-session:${oldRun.id}` || record.beatId !== (mapping?.beatId ?? `legacy-dynamic:${old.eventId}`) || record.storyVersion !== (mapping?.legacyStoryVersion ?? "legacy-v1") || canonicalSerialize(record.sourceIds) !== canonicalSerialize([...new Set(old.sourceIds)]) || canonicalSerialize(record.recipients) !== canonicalSerialize([...new Set(old.recipients)]) || canonicalSerialize(record.propositionIds) !== canonicalSerialize(mapping?.propositionIds ?? []) || record.entityIds.length || record.supersedesId || record.linkedTurnId) throw new Error("Migration semantic trace mismatch");
      if(e.legacy.representationKey !== `v2:${record.id}:${serialized.contentHash}`) throw new Error("Representation identity mismatch");
      if(serialized.bytes !== e.bytes || serialized.contentHash !== e.contentHash) throw new Error("Migrated bytes mismatch");
      if(record.sourceIds.some(id=>!ids.has(id)) || record.originIds.some(id=>!ids.has(id))) throw new Error("Foreign or missing provenance");
      if(JSON.stringify(lineage(record.id)) !== JSON.stringify(record.originIds)) throw new Error("Origin lineage mismatch");
      if(e.legacy.originalBytes !== undefined && contentHash(e.legacy.originalBytes) !== e.legacy.originalContentHash) throw new Error("Legacy bytes mismatch");
      if(e.receipt) {memoryReceiptSchema.parse(e.receipt);if(e.receipt.contentHash !== e.contentHash || e.receipt.recordId !== record.id || e.receipt.blobId || e.receipt.jobId || e.receipt.state !== "queued" || e.receipt.network !== old.network) throw new Error("Receipt representation mismatch");}
    }
  }
}
export function rollbackV2Migration(state:MigratableState):State {
  if(!state.memoryV2) throw new Error("No migration snapshot"); validateMigration(state.memoryV2);
  assertUnchangedProjection(state);
  return clone(state.memoryV2.originalState) as State;
}

/** Snapshot restore is safe only before new compatibility gameplay writes.
 * Future lifecycle tools must explicitly reconcile later events instead.
 */
function assertUnchangedProjection(state: MigratableState): void {
  const {memoryV2, ...projection} = state;
  if (!memoryV2 || contentHash(canonicalSerialize(projection)) !== memoryV2.originalStateHash)
    throw new Error("POST_MIGRATION_STATE_CHANGED");
}

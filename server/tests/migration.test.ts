import { describe,it,expect } from "vitest";
import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateV1ToV2,rollbackV2Migration,validateMigration } from "../src/migrations/v1-to-v2.js";
import { sanitizedLegacyState,makeDialogueFixture } from "./fixtures/dialogue-fixture.js";
import { serializeMemoryRecord,contentHash } from "../src/domain/serialization.js";
describe("explicit lossless v1 migration",()=>{
  it("binds migrated receipt scope and presence to the selected binding snapshot",()=>{
    const options={bindings:{"fixture-run":{accountBindingId:"binding",namespace:"scope",network:"local" as const}}};
    for(const field of ["accountBindingId","namespace","remove"]){
      const state=migrateV1ToV2(sanitizedLegacyState(),options);
      const entry=state.memoryV2!.runs["fixture-run"]!.records[0]!;
      if(field==="remove")delete entry.receipt;
      else entry.receipt![field as "accountBindingId"|"namespace"]="foreign";
      expect(()=>validateMigration(state.memoryV2!)).toThrow("Receipt binding snapshot mismatch");
    }
  });
  it("refuses rollback or reuse when gameplay changed after the snapshot",()=>{
    const state=migrateV1ToV2(sanitizedLegacyState());
    state.runs["fixture-run"]!.revision++;
    expect(()=>rollbackV2Migration(state)).toThrow("POST_MIGRATION_STATE_CHANGED");
    expect(()=>migrateV1ToV2(state)).toThrow("POST_MIGRATION_STATE_CHANGED");
  });
  it("preserves history, IDs, ledger, failed jobs and active promise without mutating input",()=>{const old=sanitizedLegacyState();const before=JSON.stringify(old);const state=migrateV1ToV2(old);expect(JSON.stringify(old)).toBe(before);expect(rollbackV2Migration(state)).toEqual(old);expect(state.runs).toEqual(old.runs);expect(state.memoryV2!.runs["fixture-run"]!.records.map(e=>[e.record.kind,e.record.epistemicStatus])).toEqual([["utterance","said"],["utterance","said"],["conversation","said"],["observation","observed"]]);});
  it("is deterministic and idempotent across JSON restart",()=>{const a=migrateV1ToV2(sanitizedLegacyState());expect(migrateV1ToV2(JSON.parse(JSON.stringify(a)))).toEqual(a);expect(migrateV1ToV2(sanitizedLegacyState())).toEqual(a);});
  it("keeps copied rumor one origin and old blob bytes separate from v2 payload",()=>{const m=migrateV1ToV2(sanitizedLegacyState()).memoryV2!;const [claim,copy,chat]=m.runs["fixture-run"]!.records;expect(copy!.record.originIds).toEqual(["claim"]);expect(claim!.legacy.receiptState).toBe("indexed");expect(claim!.legacy.originalBlobId).toBe("blob-old");expect(claim!.legacy.originalBytes).not.toBe(claim!.bytes);expect(claim!.receipt).toBeUndefined();expect(chat!.legacy.entry.jobId).toBe("failed-job");expect(chat!.legacy.unresolvedProvenance).toContain("missing_network");expect(chat!.record.propositionIds).toEqual([]);});
  it("rejects duplicate IDs, cycles and missing or foreign sources",()=>{for(const variant of ["duplicate","cycle","foreign"]){const s=sanitizedLegacyState();const records=s.runs["fixture-run"]!.records;if(variant === "duplicate")records.push({...records[0]!});else records[0]!.sourceIds=[variant === "cycle"?"copy":"foreign-id"];expect(()=>migrateV1ToV2(s)).toThrow();}});
  it("does not promote local network or reuse v1 blob/job receipt",()=>{const e=migrateV1ToV2(sanitizedLegacyState(),{bindings:{"fixture-run":{accountBindingId:"b",namespace:"n",network:"local"}}}).memoryV2!.runs["fixture-run"]!.records[0]!;expect(e.receipt!.network).toBe("local");expect(e.receipt!.state).toBe("queued");expect(e.receipt!.blobId).toBeUndefined();expect(e.receipt!.jobId).toBeUndefined();});
  it("keeps local-to-mainnet binding mismatch unresolved",()=>{const e=migrateV1ToV2(sanitizedLegacyState(),{bindings:{"fixture-run":{accountBindingId:"mainnet-b",namespace:"n",network:"mainnet"}}}).memoryV2!.runs["fixture-run"]!.records[0]!;expect(e.receipt).toBeUndefined();expect(e.legacy.unresolvedProvenance).toContain("binding_network_mismatch");expect(e.legacy.entry.network).toBe("local");});
  it("detects foreign and missing origins even if bytes are rehashed",()=>{const s=migrateV1ToV2(sanitizedLegacyState());s.memoryV2!.runs["fixture-run"]!.records[0]!.record.originIds=["foreign"];expect(()=>validateMigration(s.memoryV2!)).toThrow();});
  it("rejects a copied rumor rehashed as an independent origin",()=>{const s=migrateV1ToV2(sanitizedLegacyState());const e=s.memoryV2!.runs["fixture-run"]!.records[1]!;e.record.originIds=["copy"];Object.assign(e,serializeMemoryRecord(e.record));e.legacy.representationKey=`v2:${e.record.id}:${e.contentHash}`;expect(()=>validateMigration(s.memoryV2!)).toThrow("Origin lineage mismatch");});
  it("rejects deleted migrated history and forged owner even with newly valid hashes",()=>{const a=migrateV1ToV2(sanitizedLegacyState());a.memoryV2!.runs["fixture-run"]!.records.pop();expect(()=>validateMigration(a.memoryV2!)).toThrow();const b=migrateV1ToV2(sanitizedLegacyState());const e=b.memoryV2!.runs["fixture-run"]!.records[0]!;e.record.userId="foreign";Object.assign(e,serializeMemoryRecord(e.record));expect(()=>validateMigration(b.memoryV2!)).toThrow();});
  it("never takes a matching blob from a foreign namespace",()=>{const s=sanitizedLegacyState();s.localMemories={foreign:[{blob_id:"blob-old",text:"foreign bytes"}]};const e=migrateV1ToV2(s).memoryV2!.runs["fixture-run"]!.records[0]!;expect(e.legacy.originalBytes).toBeUndefined();});
  it("rejects forged legacy proof even with a matching rewritten hash",()=>{const s=migrateV1ToV2(sanitizedLegacyState());const e=s.memoryV2!.runs["fixture-run"]!.records[0]!;e.legacy.originalBytes="fake";e.legacy.originalContentHash=contentHash("fake");expect(()=>validateMigration(s.memoryV2!)).toThrow();});
  it("maps a legacy share to disclosure",()=>{const s=sanitizedLegacyState();s.runs["fixture-run"]!.records[1]!.type="share";expect(migrateV1ToV2(s).memoryV2!.runs["fixture-run"]!.records[1]!.record.kind).toBe("disclosure");});
  it("backs up, migrates, validates and rolls back only an isolated sanitized fixture",async()=>{const f=await makeDialogueFixture({mode:"local",scenario:"prior-question"});try{const backup=join(f.directory,"sanitized.backup.json");await writeFile(backup,JSON.stringify(sanitizedLegacyState()));await f.store.rollbackV2();expect(await f.store.transact(s=>s)).toEqual(JSON.parse(await readFile(backup,"utf8")));await f.store.migrateToV2();expect(await f.store.migrateToV2()).toEqual(await f.store.transact(s=>s.memoryV2));const result=await f.retrieval.read({runId:f.run.id,actor:"duy",query:"What did I ask before?",exactRecordIds:[],currentBeatId:f.run.beatId});expect(result.sources.some(s=>s.record.kind === "conversation")).toBe(true);expect(result.sources.every(s=>s.receipt.network === "local")).toBe(true);}finally{await f.close();}});
  it("exposes future live service as unavailable and permits injected runtime adapter",async()=>{const f=await makeDialogueFixture({mode:"live",scenario:"capability-boundary"});try{await expect(f.retrieval.read({runId:f.run.id,actor:"duy",query:"",exactRecordIds:[],currentBeatId:f.run.beatId})).rejects.toThrow("CAPABILITY_UNAVAILABLE");}finally{await f.close();}});
  it("delegates only to an explicitly injected adapter",async()=>{let calls=0;const f=await makeDialogueFixture({mode:"live",scenario:"capability-boundary",adapter:{async read(){calls++;return {traceId:"injected",sources:[],missingExactRecordIds:[],freshness:"verified_cache"};}}});try{expect((await f.retrieval.read({runId:f.run.id,actor:"duy",query:"",exactRecordIds:[],currentBeatId:f.run.beatId})).traceId).toBe("injected");expect(calls).toBe(1);}finally{await f.close();}});
  it("init never automatically migrates old state",async()=>{const f=await makeDialogueFixture({mode:"local",scenario:"migration-safety"});try{await f.store.rollbackV2();await f.store.init();expect(await f.store.transact(s=>s.memoryV2)).toBeUndefined();}finally{await f.close();}});
});

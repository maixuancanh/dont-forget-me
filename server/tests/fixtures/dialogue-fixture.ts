import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/store.js";
import { NPC_IDS, type MemoryReader, type MemoryRecordV2, type ActorProjection, type RetrievalRequest } from "../../src/domain/contracts.js";
import { serializeMemoryRecord, verifySerializedRecord } from "../../src/domain/serialization.js";
import type { State } from "../../src/model.js";
export function sanitizedLegacyState():State {
  return {users:{"fixture-user":{id:"fixture-user",name:"Sanitized fixture"}},localMemories:{"dfm:v1:fixture-user:fixture-run:case":[{blob_id:"blob-old",text:'{"recordId":"claim","eventId":"unknown-claim","runId":"fixture-run","schemaVersion":1}'}]},runs:{"fixture-run":{id:"fixture-run",userId:"fixture-user",day:3,cursor:4,revision:7,records:[
    {id:"claim",eventId:"unknown-claim",runId:"fixture-run",day:1,speaker:"duy",quote:"I was away.",clueTags:["rumor"],sourceIds:[],recipients:["player","duy"],type:"claim",status:"confirmed",blobId:"blob-old",jobId:"job-old",createdAt:"2026-01-01T00:00:00.000Z",network:"local"},
    {id:"copy",eventId:"unknown-copy",runId:"fixture-run",day:2,speaker:"hanh",quote:"Duy said he was away.",clueTags:[],sourceIds:["claim"],recipients:["player"],type:"claim",status:"local",createdAt:"2026-01-01T00:00:00.000Z",network:"local"},
    {id:"chat",eventId:"chat:old",runId:"fixture-run",day:2,speaker:"duy",quote:"You asked about the notebook.",clueTags:[],sourceIds:[],recipients:["player","duy"],type:"conversation",status:"failed",jobId:"failed-job",error:"temporary",attempts:2,retryAt:100,createdAt:"2026-01-01T00:00:00.000Z"},
    {id:"observation",eventId:"unknown-observed",runId:"fixture-run",day:3,speaker:"player",quote:"I saw the red notebook.",clueTags:[],sourceIds:[],recipients:["player"],type:"observation",status:"pending",createdAt:"2026-01-01T00:00:00.000Z"},
  ],shares:[{id:"share-old",recordId:"claim",recipient:"hanh"}],promise:{id:"promise-old",recipient:"duy",kept:true},outcome:"unresolved",turns:[{id:"turn-old",response:{utterance:"Prior answer"}}],completedLedger:[{id:"payment-old",status:"completed"}],unresolvedJobs:[{id:"failed-job",state:"failed"}] } as State["runs"][string]}};
}
export async function makeDialogueFixture(options:{mode:"local"|"live";scenario:string;adapter?:MemoryReader}) {
  if(!["prior-question","migration-safety","capability-boundary"].includes(options.scenario)) throw new Error("CAPABILITY_UNAVAILABLE: fixture scenario is unimplemented");
  const directory = await mkdtemp(join(tmpdir(),"dfm-dialogue-fixture-"));
  const store = new Store(join(directory,"state.json"));
  try {
  await store.init(); await store.transact(state=>Object.assign(state,sanitizedLegacyState()));
  const migrated = await store.migrateToV2({bindings:{"fixture-run":{accountBindingId:"fixture-binding",namespace:"fixture-local",network:"local"}}});
  const records = migrated.runs["fixture-run"]!.records.map(e=>e.record);
  const projections:ActorProjection[] = NPC_IDS.map(npcId=>({npcId,knownRecordIds:records.filter(r=>r.actor === npcId || r.recipients.includes(npcId)).map(r=>r.id),trustCauseIds:[],activeCommitmentIds:npcId === "duy"?["promise-old"]:[],unresolvedTopicIds:[],stance:"open",stanceCauseIds:[]}));
  const localReader:MemoryReader = {async read(request:RetrievalRequest) {
    if(request.runId !== "fixture-run") throw new Error("FORBIDDEN");
    const allowed = records.filter(r=>r.actor === request.actor || r.recipients.includes(request.actor));
    const selected = request.exactRecordIds.length?allowed.filter(r=>request.exactRecordIds.includes(r.id)):allowed;
    return {traceId:`fixture:${options.scenario}`,freshness:"verified_cache",missingExactRecordIds:request.exactRecordIds.filter(id=>!selected.some(r=>r.id === id)),sources:selected.map(record=>{
      const serialized=serializeMemoryRecord(record);
      const verified:MemoryRecordV2=verifySerializedRecord(serialized.bytes,serialized.contentHash);
      return {record:verified,retrieval:request.exactRecordIds.includes(record.id)?"exact":"recent",receipt:{recordId:record.id,accountBindingId:"fixture-binding",namespace:"fixture-local",network:"local",state:"retrievable",blobId:`fixture-local:${record.id}`,contentHash:serialized.contentHash,verifiedAt:"2026-01-01T00:00:00.000Z",lastRecallAt:"2026-01-01T00:00:00.000Z"}};
    })};
  }};
  const retrieval:MemoryReader=options.adapter ?? (options.mode === "local"?localReader:{async read(){throw new Error("CAPABILITY_UNAVAILABLE: live retrieval service is unimplemented");}});
  return {store,directory,account:{id:"fixture-binding",network:"local" as const},run:{id:"fixture-run",userId:"fixture-user",beatId:"legacy-dynamic:chat:old"},records,projections,retrieval,capabilities:{localVerifiedReader:options.mode === "local" && !options.adapter,injectedReader:Boolean(options.adapter),liveVerified:false,dialogueGeneration:false},async close(){try {await store.close();} finally {await rm(directory,{recursive:true,force:true});}}};
  } catch(error) {try {await store.close();} finally {await rm(directory,{recursive:true,force:true});} throw error;}
}

import { z } from "zod";
import { NPC_IDS } from "./contracts.js";
const id = z.string().min(1).refine(v => !["__proto__", "constructor", "prototype"].includes(v), "Unsafe identifier");
const ids = z.array(id).refine(v => new Set(v).size === v.length, "Duplicate IDs");
const npc = z.enum(NPC_IDS);
const participant = z.union([npc, z.literal("player")]);
export const memoryRecordV2Schema = z.object({
  schemaVersion: z.literal(2), id, eventId: id, userId: id, runId: id, sessionId: id,
  sequence: z.number().int().nonnegative(), storyVersion: id, beatId: id, inGameDay: z.number().int().min(1),
  createdAt: z.string().datetime({offset:true}), actor: z.union([participant,z.literal("system")]),
  kind: z.enum(["utterance","conversation","observation","hypothesis","promise","relationship","disclosure","comparison","correction","task","alias","interpretation","outcome","manifest"]),
  text: z.string().min(1), epistemicStatus: z.enum(["said","observed","hypothesized","corroborated"]),
  sourceIds: ids, originIds: ids, recipients: z.array(participant).refine(v => new Set(v).size === v.length),
  supersedesId: id.optional(), entityIds: ids, propositionIds: ids, linkedTurnId: id.optional(),
}).strict().superRefine((v,c) => {
  if (v.supersedesId === v.id) c.addIssue({code:"custom",message:"Self correction is invalid"});
  if (v.kind === "correction" && !v.supersedesId) c.addIssue({code:"custom",message:"Correction requires supersedesId"});
  if (["utterance","conversation"].includes(v.kind) && v.epistemicStatus !== "said") c.addIssue({code:"custom",message:"Speech is a statement, not truth"});
  if (v.kind === "hypothesis" && v.epistemicStatus !== "hypothesized") c.addIssue({code:"custom",message:"Hypothesis requires hypothesized status"});
  if (v.kind === "observation" && v.epistemicStatus !== "observed") c.addIssue({code:"custom",message:"Observation requires observed status"});
});
export const memoryReceiptSchema = z.object({
  recordId:id,accountBindingId:id,namespace:id,network:z.enum(["local","mainnet"]),
  state:z.enum(["queued","accepted","uploaded","indexed","retrievable","retryable_failure","permanent_failure"]),
  contentHash:z.string().regex(/^[a-f0-9]{64}$/),jobId:id.optional(),blobId:id.optional(),objectId:id.optional(),
  transactionDigest:id.optional(),expiryEpoch:z.number().int().nonnegative().optional(),
  verifiedAt:z.string().datetime({offset:true}).optional(),lastRecallAt:z.string().datetime({offset:true}).optional(),
}).strict().superRefine((v,c)=>{
  if (["uploaded","indexed","retrievable"].includes(v.state) && !v.blobId) c.addIssue({code:"custom",message:"Persisted receipt requires blobId"});
  if(v.state === "retrievable" && (!v.verifiedAt || !v.lastRecallAt)) c.addIssue({code:"custom",message:"Retrievable requires verification and recall proof"});
});
export const actorProjectionSchema = z.object({npcId:npc,knownRecordIds:ids,trustCauseIds:ids,activeCommitmentIds:ids,unresolvedTopicIds:ids,stance:z.enum(["open","guarded","defensive","correcting"]),stanceCauseIds:ids,lastAcknowledgedTurnId:id.optional()}).strict();
export const commitmentSchema = z.object({id,type:z.enum(["promise","task"]),proposer:participant,beneficiary:participant,topicEntityIds:ids,condition:z.enum(["keep_confidential","show_source","check_record","reserve_item"]),targetIds:ids,forbiddenRecipients:z.array(npc),permittedRecipients:z.array(npc),status:z.enum(["offered","accepted","fulfilled","breached","withdrawn"]),sourceIds:ids,dueBeatId:id.optional()}).strict();
export const MemoryRecordV2Schema = memoryRecordV2Schema;
export const MemoryReceiptSchema = memoryReceiptSchema;

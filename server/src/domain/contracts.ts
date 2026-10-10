export const NPC_IDS = ["binh", "hanh", "bao", "lan", "thu", "sau", "duy", "tuan", "phuc"] as const;
export type NpcId = typeof NPC_IDS[number];
export type Actor = NpcId | "player" | "system";
export type RecordKind = "utterance" | "conversation" | "observation" | "hypothesis" | "promise" | "relationship" | "disclosure" | "comparison" | "correction" | "task" | "alias" | "interpretation" | "outcome" | "manifest";
export type EpistemicStatus = "said" | "observed" | "hypothesized" | "corroborated";
export interface MemoryRecordV2 {
  schemaVersion: 2; id: string; eventId: string; userId: string; runId: string; sessionId: string;
  sequence: number; storyVersion: string; beatId: string; inGameDay: number; createdAt: string;
  actor: Actor; kind: RecordKind; text: string; epistemicStatus: EpistemicStatus;
  sourceIds: string[]; originIds: string[]; recipients: Array<NpcId | "player">;
  supersedesId?: string; entityIds: string[]; propositionIds: string[]; linkedTurnId?: string;
}
export type WriteState = "queued" | "accepted" | "uploaded" | "indexed" | "retrievable" | "retryable_failure" | "permanent_failure";
export interface MemoryReceipt {
  recordId: string; accountBindingId: string; namespace: string; network: "local" | "mainnet";
  state: WriteState; contentHash: string; jobId?: string; blobId?: string; objectId?: string;
  transactionDigest?: string; expiryEpoch?: number; verifiedAt?: string; lastRecallAt?: string;
}
export interface Commitment {
  id: string; type: "promise" | "task"; proposer: NpcId | "player"; beneficiary: NpcId | "player";
  topicEntityIds: string[]; condition: "keep_confidential" | "show_source" | "check_record" | "reserve_item";
  targetIds: string[]; forbiddenRecipients: NpcId[]; permittedRecipients: NpcId[];
  status: "offered" | "accepted" | "fulfilled" | "breached" | "withdrawn"; sourceIds: string[]; dueBeatId?: string;
}
export interface ActorProjection {
  npcId: NpcId; knownRecordIds: string[]; trustCauseIds: string[]; activeCommitmentIds: string[];
  unresolvedTopicIds: string[]; stance: "open" | "guarded" | "defensive" | "correcting";
  stanceCauseIds: string[]; lastAcknowledgedTurnId?: string;
}
export interface RetrievalRequest { runId: string; actor: NpcId | "player"; query: string; exactRecordIds: string[]; currentBeatId: string }
export interface VerifiedSource { record: MemoryRecordV2; receipt: MemoryReceipt; retrieval: "semantic" | "recent" | "exact" | "verified_reference" }
export interface RetrievalResult { traceId: string; sources: VerifiedSource[]; missingExactRecordIds: string[]; freshness: "live" | "verified_cache" }
export interface MemoryReader { read(request: RetrievalRequest): Promise<RetrievalResult> }

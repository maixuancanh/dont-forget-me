export type NPC =
  | "binh"
  | "hanh"
  | "bao"
  | "lan"
  | "thu"
  | "sau"
  | "duy"
  | "tuan"
  | "phuc";
export interface RecordEntry {
  id: string;
  eventId: string;
  runId: string;
  day: number;
  speaker: string;
  quote: string;
  clueTags: string[];
  sourceIds: string[];
  recipients: string[];
  type: string;
  status: "pending" | "confirmed" | "local" | "failed";
  blobId?: string;
  jobId?: string;
  error?: string;
  createdAt: string;
  attempts?: number;
  retryAt?: number;
  recalledAt?: string;
  network?: "mainnet" | "local";
}
/** Retained v1 API projection. New immutable records use MemoryRecordV2. */
export type RecordEntryV1 = RecordEntry;
export interface Run {
  id: string;
  userId: string;
  day: number;
  cursor: number;
  revision: number;
  records: RecordEntry[];
  shares: { recordId: string; recipient: string; id: string }[];
  promise?: { id: string; recipient: string; kept: boolean };
  outcome?: "resolved" | "unresolved";
  turns: { id: string; response: unknown }[];
}
export interface State {
  memoryV2?: import("./migrations/v1-to-v2.js").MigrationV2;
  users: Record<string, { id: string; name: string }>;
  runs: Record<string, Run>;
  localMemories: Record<string, { blob_id: string; text: string }[]>;
}
export interface CanonEvent {
  id: string;
  sceneId: string;
  stepIndex: number;
  day: number;
  speaker: string;
  quote: string;
  category: string;
  clueTags: string[];
}

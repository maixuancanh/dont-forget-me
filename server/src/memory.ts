import { MemWal } from "@mysten-incubation/memwal";
import type { RecordEntry, State } from "./model.js";
export interface MemoryAdapter {
  mode: string;
  write(
    text: string,
    namespace: string,
    id: string,
    jobId?: string,
    onAccepted?: (jobId: string) => Promise<void>,
  ): Promise<{ blobId: string; jobId?: string }>;
  recall(
    query: string,
    namespace: string,
  ): Promise<{ blob_id: string; text: string }[]>;
}
export class WalrusMemory implements MemoryAdapter {
  mode = "mainnet";
  private sdk: MemWal;
  constructor(key: string, accountId: string, serverUrl: string) {
    if (serverUrl !== "https://relayer.memory.walrus.xyz")
      throw new Error("Mainnet relayer required");
    this.sdk = MemWal.create({ key, accountId, serverUrl });
  }
  async write(
    text: string,
    namespace: string,
    id: string,
    jobId?: string,
    onAccepted?: (jobId: string) => Promise<void>,
  ) {
    if (!jobId) {
      const accepted = await this.sdk.remember(text, namespace, {
        idempotencyKey: id,
      });
      jobId = accepted.job_id;
      await onAccepted?.(jobId);
    }
    const r = await this.sdk.waitForRememberJob(jobId, { timeoutMs: 30000 });
    return { blobId: r.blob_id, jobId: r.job_id };
  }
  async recall(query: string, namespace: string) {
    const r = await this.sdk.recall({
      query,
      namespace,
      limit: 20,
      maxDistance: 0.8,
    });
    return r.results;
  }
  destroy() { this.sdk.destroy(); }
}
export const scope = (user: string, run: string) =>
  `dfm:v1:${user}:${run}:case`;
export const payload = (r: RecordEntry) =>
  JSON.stringify({
    schemaVersion: 1,
    eventId: r.eventId,
    recordId: r.id,
    runId: r.runId,
    day: r.day,
    speaker: r.speaker,
    quote: r.quote,
    clueTags: r.clueTags,
    sourceIds: r.sourceIds,
    recipients: r.recipients,
    type: r.type,
    createdAt: r.createdAt,
  });
export function localWrite(
  state: State,
  text: string,
  namespace: string,
  id: string,
) {
  const items = (state.localMemories[namespace] ??= []);
  if (!items.some((x) => x.blob_id === id)) items.push({ blob_id: id, text });
  return id;
}

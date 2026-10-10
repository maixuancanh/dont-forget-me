import { it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { schema, config } from "../src/config.js";
import type { MemoryAdapter } from "../src/memory.js";
const events = JSON.parse(
  await readFile(
    new URL("../story/legacy-v1-events.json", import.meta.url),
    "utf8",
  ),
).filter((e: any) => e.sceneId !== "Ending");
it("production cannot silently fall back to local or unverified login", () => {
  expect(() =>
    config({
      SESSION_SECRET: "long-test-key-at-least-thirty-two-characters",
      APP_MODE: "production",
      MEMORY_MODE: "local",
    } as any),
  ).toThrow(/Production requires/);
});
it("accepted job survives failure/restart and resumes without a second remember", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfm-recovery-"));
  const c = schema.parse({
    SESSION_SECRET: "long-test-key-at-least-thirty-two-characters",
    DATA_FILE: join(dir, "state.json"),
  });
  let attempts = 0;
  let passedJob: string | undefined;
  const adapter: MemoryAdapter = {
    mode: "mainnet",
    write: async (_text, _ns, id, job, onAccepted) => {
      attempts++;
      passedJob = job;
      if (!job) {
        await onAccepted?.("accepted-job");
        throw new Error("Index timeout");
      }
      return { blobId: id, jobId: job };
    },
    recall: async () => [],
  };
  const first = await createApp(c, adapter);
  let second: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const login = (
      await first.app.inject({
        method: "POST",
        url: "/v1/session",
        payload: { name: "Recovery", accessCode: "recovery-access-code" },
      })
    ).json();
    const headers = { authorization: "Bearer " + login.token };
    const run = (
      await first.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers,
        payload: {},
      })
    ).json().run;
    await first.app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/events`,
      headers,
      payload: events[0],
    });
    await first.flush();
    const record = await first.store.transact(
      (s) => s.runs[run.id]!.records[0]!,
    );
    expect(record.status).toBe("failed");
    expect(record.jobId).toBe("accepted-job");
    await first.app.close();
    second = await createApp(c, adapter);
    await second.store.transact((s) => {
      s.runs[run.id]!.records[0]!.retryAt = 0;
    });
    await second.flush();
    expect(attempts).toBe(2);
    expect(passedJob).toBe("accepted-job");
    const restored = await second.store.transact(
      (s) => s.runs[run.id]!.records[0]!,
    );
    expect(restored.status).toBe("confirmed");
    expect(restored.blobId).toBe(record.id);
  } finally {
    await (second?.app ?? first.app).close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("Duy reveal needs explicit promise and reassurance; duplicate reassurance cannot multiply trust", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dfm-trust-"));
  const instance = await createApp(
    schema.parse({
      SESSION_SECRET: "long-test-key-at-least-thirty-two-characters",
      DATA_FILE: join(dir, "state.json"),
    }),
  );
  try {
    const login = (
      await instance.app.inject({
        method: "POST",
        url: "/v1/session",
        payload: { name: "Trust", accessCode: "trust-access-code" },
      })
    ).json();
    const headers = { authorization: "Bearer " + login.token };
    const run = (
      await instance.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers,
        payload: {},
      })
    ).json().run;
    const post = (suffix: string, payload: any) =>
      instance.app.inject({
        method: "POST",
        url: `/v1/runs/${run.id}/${suffix}`,
        headers,
        payload,
      });
    for (const event of events) await post("events", event);
    await post("promises", { npcId: "duy", action: "accept" });
    expect(
      await instance.store.transact((s) =>
        s.runs[run.id]!.records.some((r) => r.eventId === "DuyTrust:0"),
      ),
    ).toBe(false);
    await post("promises", { npcId: "duy", action: "reassure" });
    await post("promises", { npcId: "duy", action: "reassure" });
    expect(
      await instance.store.transact(
        (s) =>
          s.runs[run.id]!.records.filter((r) => r.eventId === "DuyTrust:0")
            .length,
      ),
    ).toBe(1);
  } finally {
    await instance.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});


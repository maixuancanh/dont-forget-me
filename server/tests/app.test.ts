import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { schema } from "../src/config.js";
import type { MemoryAdapter } from "../src/memory.js";
const catalog = JSON.parse(
  await readFile(
    new URL("../story/legacy-v1-events.json", import.meta.url),
    "utf8",
  ),
).filter((e: any) => e.sceneId !== "Ending");
async function fixture(adapter?: MemoryAdapter) {
  const dir = await mkdtemp(join(tmpdir(), "dfm-test-"));
  const c = schema.parse({
    SESSION_SECRET: "test-key-with-at-least-thirty-two-characters",
    DATA_FILE: join(dir, "state.json"),
  });
  const instance = await createApp(c, adapter);
  const api = async (
    method: any,
    path: string,
    payload?: any,
    token?: string,
  ) => {
    const result = await instance.app.inject({
      method,
      url: path,
      payload,
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    return { status: result.statusCode, ...result.json() };
  };
  const session = await api("POST", "/v1/session", {
    name: "Tester",
    accessCode: "test-access-code",
  });
  const run = await api("POST", "/v1/runs", {}, session.token);
  return {
    ...instance,
    dir,
    c,
    api,
    token: session.token,
    id: run.run.id,
    close: async () => {
      await instance.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
describe("authenticated story and durable memory", () => {
  it("resumes a completed six-day witness timeline at the ledger instead of replaying day six", async () => {
    const f = await fixture();
    try {
      for (const event of catalog)
        expect((await f.api("POST", `/v1/runs/${f.id}/events`, {sceneId:event.sceneId,stepIndex:event.stepIndex}, f.token)).status).toBe(200);
      const checkpoint = await f.api("GET", `/v1/runs/${f.id}`, undefined, f.token);
      expect(checkpoint.nextEvent).toEqual({sceneId:"Ledger",stepIndex:0,day:6});
      expect(checkpoint.run.cursor).toBe(catalog.length);
    } finally { await f.close(); }
  });
  it("rejects another identity, missing token and future checkpoint; replays exact event once", async () => {
    const f = await fixture();
    try {
      expect((await f.api("GET", "/v1/runs/" + f.id)).status).toBe(401);
      const other = await f.api("POST", "/v1/session", {
        name: "Other",
        accessCode: "another-user-code",
      });
      expect(
        (await f.api("GET", "/v1/runs/" + f.id, undefined, other.token)).status,
      ).toBe(404);
      expect(
        (await f.api("POST", `/v1/runs/${f.id}/events`, catalog[1], f.token))
          .status,
      ).toBe(400);
      for (let i = 0; i < 2; i++)
        expect(
          (await f.api("POST", `/v1/runs/${f.id}/events`, catalog[0], f.token))
            .status,
        ).toBe(200);
      await f.flush();
      const journal = await f.api(
        "GET",
        `/v1/runs/${f.id}/journal`,
        undefined,
        f.token,
      );
      expect(journal.records).toHaveLength(1);
      expect(journal.records[0].claimStatus).toBe("local");
      const second = await f.api("POST", "/v1/runs", {}, f.token);
      expect(
        (
          await f.api(
            "GET",
            `/v1/runs/${second.run.id}/journal`,
            undefined,
            f.token,
          )
        ).records,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("restores same identity and run after server restart without trusting the display name", async () => {
    const f = await fixture();
    await f.api("POST", `/v1/runs/${f.id}/events`, catalog[0], f.token);
    await f.flush();
    await f.app.close();
    const restored = await createApp(f.c);
    try {
      const login = (
        await restored.app.inject({
          method: "POST",
          url: "/v1/session",
          payload: { name: "Changed", accessCode: "test-access-code" },
        })
      ).json();
      const result = await restored.app.inject({
        method: "GET",
        url: "/v1/runs/" + f.id,
        headers: { authorization: "Bearer " + login.token },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().run.records).toHaveLength(1);
    } finally {
      await restored.app.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("requires exact retrieved payload, rejects corrupted/empty recall, and deduplicates chat turns", async () => {
    let corrupted = false;
    const items: { blob_id: string; text: string }[] = [];
    const adapter: MemoryAdapter = {
      mode: "mainnet",
      write: async (text, _ns, id) => {
        items.push({ blob_id: id, text });
        return { blobId: id };
      },
      recall: async () =>
        corrupted ? items.map((i) => ({ ...i, text: "{}" })) : items,
    };
    const f = await fixture(adapter);
    try {
      await f.api("POST", `/v1/runs/${f.id}/events`, catalog[0], f.token);
      await f.flush();
      const body = {
        npcId: "binh",
        message: "What do you remember?",
        clientTurnId: "turn-1",
      };
      const reply = await f.api("POST", `/v1/runs/${f.id}/chat`, body, f.token);
      expect(reply.sourceIds).toHaveLength(1);
      expect(
        (await f.api("POST", `/v1/runs/${f.id}/chat`, body, f.token)).sourceIds,
      ).toEqual(reply.sourceIds);
      corrupted = true;
      const journal = await f.api(
        "GET",
        `/v1/runs/${f.id}/journal`,
        undefined,
        f.token,
      );
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/share`,
            { recordId: journal.records[0].id, recipient: "hanh" },
            f.token,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/chat`,
            { ...body, npcId: "phuc", clientTurnId: "future" },
            f.token,
          )
        ).status,
      ).toBe(400);
    } finally {
      await f.close();
    }
  });
  it("all six days reach independently supported case; unreported sources cannot resolve", async () => {
    const f = await fixture();
    try {
      for (const e of catalog)
        expect(
          (await f.api("POST", `/v1/runs/${f.id}/events`, e, f.token)).status,
        ).toBe(200);
      await f.flush();
      const journal = await f.api(
        "GET",
        `/v1/runs/${f.id}/journal`,
        undefined,
        f.token,
      );
      const eventIds = [
        "Day4_1_Layla:8",
        "Day6_2_Mario:0",
        "Day6_3_Jomar:10",
        "Ledger:0",
      ];
      const ids = journal.records
        .filter((r: any) => eventIds.includes(r.eventId))
        .map((r: any) => r.id);
      expect(ids).toHaveLength(4);
      const pair = journal.records
        .filter((r: any) => ["Day2_1_Junjun:4", "Ledger:0"].includes(r.eventId))
        .map((r: any) => r.id);
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/confront`,
            { recordIds: pair },
            f.token,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/compare`,
            { recordIds: pair },
            f.token,
          )
        ).supported,
      ).toBe(true);
      const confrontation = await f.api(
        "POST",
        `/v1/runs/${f.id}/confront`,
        { recordIds: pair },
        f.token,
      );
      expect(confrontation.status).toBe(200);
      expect(confrontation.npcId).toBe("hanh");
      expect(confrontation.sourceIds).toEqual(pair);
      const exported = await f.api(
        "GET",
        `/v1/runs/${f.id}/export`,
        undefined,
        f.token,
      );
      expect(exported.confirmedDistinctBlobs).toBe(0);
      expect(exported.verifiedHuman).toBe(false);
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/case`,
            { recordIds: ids },
            f.token,
          )
        ).outcome,
      ).toBe("unresolved");
      for (const id of ids)
        expect(
          (
            await f.api(
              "POST",
              `/v1/runs/${f.id}/share`,
              { recordId: id, recipient: "phuc" },
              f.token,
            )
          ).status,
        ).toBe(200);
      expect(
        (
          await f.api(
            "POST",
            `/v1/runs/${f.id}/case`,
            { recordIds: ids },
            f.token,
          )
        ).outcome,
      ).toBe("resolved");
    } finally {
      await f.close();
    }
  });
});


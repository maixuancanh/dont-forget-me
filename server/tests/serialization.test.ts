import { describe, expect, it } from "vitest";
import { canonicalSerialize, contentHash, serializeMemoryRecord, verifySerializedRecord } from "../src/domain/serialization.js";
import type { MemoryRecordV2 } from "../src/domain/contracts.js";
import { execFileSync } from "node:child_process";

const record = (): MemoryRecordV2 => ({
  schemaVersion: 2, id: "record-1", eventId: "event-1", userId: "user-1", runId: "run-1",
  sessionId: "session-1", sequence: 1, storyVersion: "full-memory-v2", beatId: "v2.Day1_1_Junjun.0",
  inGameDay: 1, createdAt: "2026-10-09T00:00:00.000Z", actor: "binh", kind: "utterance",
  text: "I asked for coffee.", epistemicStatus: "said", sourceIds: [], originIds: ["record-1"],
  recipients: ["player", "binh"], entityIds: ["coffee_strip"], propositionIds: [],
});

describe("immutable memory bytes", () => {
  it("sorts keys recursively while preserving significant array order and Unicode", () => {
    const a = { z: ["Việt Nam", { b: 2, a: 1 }], a: "\n\"" };
    const b = { a: "\n\"", z: ["Việt Nam", { a: 1, b: 2 }] };
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
    expect(canonicalSerialize(["a", "b"])).not.toBe(canonicalSerialize(["b", "a"]));
    expect(JSON.parse(canonicalSerialize(a))).toEqual(a);
  });
  it("hashes exact UTF-8 bytes with SHA-256", () => {
    expect(contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(contentHash("é")).not.toBe(contentHash("e\u0301"));
  });
  it("keeps a saved payload unchanged through mutation and process-style JSON reload", () => {
    const source = record(), saved = serializeMemoryRecord(source);
    source.text = "An edited claim.";
    expect(saved.bytes).toContain("I asked for coffee.");
    const reloaded = verifySerializedRecord(saved.bytes, saved.contentHash);
    expect(serializeMemoryRecord(reloaded)).toEqual(saved);
    expect(serializeMemoryRecord(source).contentHash).not.toBe(saved.contentHash);
  });
  it("rejects changed text with an old hash", () => {
    const saved = serializeMemoryRecord(record());
    expect(() => verifySerializedRecord(saved.bytes.replace("coffee", "tea"), saved.contentHash)).toThrow("CONTENT_HASH_MISMATCH");
  });
  it("verifies saved bytes in a fresh Node process without state from the writer", () => {
    const saved = serializeMemoryRecord(record());
    const code = `import {readFileSync} from 'node:fs';
      const {verifySerializedRecord,serializeMemoryRecord}=await import(process.argv[1]);
      const saved=JSON.parse(readFileSync(0,'utf8'));
      process.stdout.write(JSON.stringify(serializeMemoryRecord(verifySerializedRecord(saved.bytes,saved.contentHash))));`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code,
      new URL("../src/domain/serialization.ts", import.meta.url).href],
      { input: JSON.stringify(saved), encoding: "utf8", timeout: 10000 });
    expect(JSON.parse(output)).toEqual(saved);
  });
  it("rejects noncanonical encodings and duplicate keys even when their raw hash matches", () => {
    const source = record();
    for (const bytes of [JSON.stringify(source, null, 2), serializeMemoryRecord(source).bytes.replace('"actor":"binh"', '"actor":"hanh","actor":"binh"')]) {
      expect(() => verifySerializedRecord(bytes, contentHash(bytes))).toThrow("NON_CANONICAL_PAYLOAD");
    }
  });
  it("does not admit mutable receipts or extra operational fields as record payload", () => {
    expect(() => serializeMemoryRecord({ ...record(), retryAt: 100 } as MemoryRecordV2)).toThrow();
    expect(() => serializeMemoryRecord({ ...record(), schemaVersion: 1 } as unknown as MemoryRecordV2)).toThrow();
  });
  it("refuses non-JSON values rather than dropping or coercing them", () => {
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), { absent: undefined }, [undefined], () => 1]) {
      expect(() => canonicalSerialize(value)).toThrow();
    }
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(() => canonicalSerialize(cycle)).toThrow();
  });
  it("rejects accessors and prototype keys without invoking them", () => {
    let accessed = false;
    const data = Object.defineProperty({}, "value", { enumerable: true, get: () => { accessed = true; return 1; } });
    expect(() => canonicalSerialize(data)).toThrow(); expect(accessed).toBe(false);
    expect(() => canonicalSerialize(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(() => canonicalSerialize(Object.create({ hidden: true }))).toThrow();
  });
});

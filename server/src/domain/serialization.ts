import { createHash } from "node:crypto";
import type { MemoryRecordV2 } from "./contracts.js";
import { memoryRecordV2Schema } from "./schemas.js";

/** Project canonical JSON: UTF-8, sorted object keys, ordered arrays, no coercion.
 * Not an assertion of RFC 8785 interoperability. Store these exact bytes.
 */
export function canonicalSerialize(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (node: unknown): string => {
    if (node === null) return "null";
    if (typeof node === "string" || typeof node === "boolean") return JSON.stringify(node);
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new Error("NON_JSON_NUMBER");
      return JSON.stringify(node);
    }
    if (typeof node !== "object") throw new Error("NON_JSON_VALUE");
    if (ancestors.has(node)) throw new Error("CYCLIC_PAYLOAD");
    const array = Array.isArray(node);
    if (!array && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null)
      throw new Error("NON_JSON_OBJECT");
    ancestors.add(node);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(node);
      if (Object.getOwnPropertySymbols(node).length) throw new Error("NON_JSON_SYMBOL_KEY");
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor.get || descriptor.set) throw new Error("PAYLOAD_ACCESSOR");
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("UNSAFE_PAYLOAD_KEY");
        if (!descriptor.enumerable && !(array && key === "length")) throw new Error("NON_JSON_HIDDEN_KEY");
      }
      if (array) {
        const parts: string[] = [];
        if (Object.keys(descriptors).length !== node.length + 1) throw new Error("NON_JSON_ARRAY");
        for (let index = 0; index < node.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) throw new Error("SPARSE_PAYLOAD_ARRAY");
          parts.push(visit(descriptor.value));
        }
        return `[${parts.join(",")}]`;
      }
      return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key]!.value)}`).join(",")}}`;
    } finally { ancestors.delete(node); }
  };
  return visit(value);
}

export function contentHash(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function serializeMemoryRecord(record: MemoryRecordV2): Readonly<{ bytes: string; contentHash: string }> {
  // Check raw input before schema parsing: schemas must not silently coerce or
  // invoke accessors and a receipt must not leak into immutable content.
  canonicalSerialize(record);
  const validated = memoryRecordV2Schema.parse(record);
  const bytes = canonicalSerialize(validated);
  return Object.freeze({ bytes, contentHash: contentHash(bytes) });
}

export function verifySerializedRecord(bytes: string, expectedHash: string): MemoryRecordV2 {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || contentHash(bytes) !== expectedHash)
    throw new Error("CONTENT_HASH_MISMATCH");
  const record = memoryRecordV2Schema.parse(JSON.parse(bytes));
  if (canonicalSerialize(record) !== bytes) throw new Error("NON_CANONICAL_PAYLOAD");
  return record;
}

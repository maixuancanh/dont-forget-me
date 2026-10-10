import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { addRecord, compare, confront, decide, known, share } from "../src/rules.js";
import type { Run, CanonEvent } from "../src/model.js";
const canon: CanonEvent[] = JSON.parse(
  readFileSync(
    new URL("../story/legacy-v1-events.json", import.meta.url),
    "utf8",
  ),
);
const run = (): Run => ({
  id: "run-a",
  userId: "user-a",
  day: 6,
  cursor: 0,
  revision: 0,
  records: [],
  shares: [],
  turns: [],
});
function witness(r: Run, id: string) {
  const e = canon.find((e) => e.id === id)!;
  const row = addRecord(r, e.id, e.quote, e.speaker, e.clueTags, e.category);
  row.day = e.day;
  row.status = "local";
  return row;
}
const route = [
  "Ledger:0",
  "Day4_1_Layla:8",
  "Day6_2_Mario:0",
  "Day6_3_Jomar:10",
];
describe("authored investigation rules", () => {
  it("resolves alternate independent route without Duy trust, only after reporting every selected source", () => {
    const r = run();
    const ids = route.map((id) => witness(r, id).id);
    expect(decide(r, ids).outcome).toBe("unresolved");
    ids.forEach((id) => share(r, id, "phuc"));
    expect(decide(r, ids).outcome).toBe("resolved");
    expect(r.promise).toBeUndefined();
  });
  it("preserves originals and derives recipient knowledge from append-only shares", () => {
    const r = run(),
      a = witness(r, "Day5_4_Carlo:13");
    const before = JSON.stringify(a);
    expect(known(r, "phuc")).not.toContain(a);
    share(r, a.id, "phuc");
    share(r, a.id, "phuc");
    expect(JSON.stringify(a)).toBe(before);
    expect(known(r, "phuc")).toContain(a);
    expect(r.shares).toHaveLength(1);
  });
  it("allows Phuc report, breaks promise for Hanh idempotently, without granting Duy breach knowledge", () => {
    const r = run();
    r.promise = { id: "protect_duy_from_hanh", recipient: "duy", kept: true };
    const a = witness(r, "Day5_4_Carlo:13");
    share(r, a.id, "phuc");
    expect(r.promise.kept).toBe(true);
    share(r, a.id, "hanh");
    share(r, a.id, "hanh");
    expect(r.promise.kept).toBe(false);
    expect(
      r.records.filter((x) => x.eventId === "promise:breach"),
    ).toHaveLength(1);
    expect(known(r, "duy").some((x) => x.eventId === "promise:breach")).toBe(
      false,
    );
  });
  it("requires precise authored pairs and contributions from both records", () => {
    const r = run(),
      ledger = witness(r, "Ledger:0"),
      order = witness(r, "Day1_3_Axel:0");
    expect(compare(r, [ledger.id, order.id]).supported).toBe(false);
    const identity = witness(r, "Day6_3_Jomar:10"),
      coffee = witness(r, "Day5_3_Lucia:4");
    expect(compare(r, [identity.id, coffee.id]).supported).toBe(false);
    const pendingIdentity = witness(r, "Day5_2_Jomar:5");
    expect(compare(r, [pendingIdentity.id, coffee.id]).kind).toBe(
      "unreleased_coffee_detail",
    );
  });
  it("rejects foreign, future, pending and duplicate selected sources", () => {
    const r = run(),
      a = witness(r, "Ledger:0"),
      b = witness(r, "Day2_1_Junjun:4");
    a.runId = "foreign";
    expect(() => share(r, a.id, "phuc")).toThrow();
    expect(() => compare(r, [a.id, b.id])).toThrow();
    expect(() => decide(r, [a.id])).toThrow();
    a.runId = r.id;
    a.day = 7;
    expect(() => share(r, a.id, "phuc")).toThrow();
    a.day = 6;
    a.status = "pending";
    expect(() => decide(r, [a.id])).toThrow();
    expect(() => compare(r, [b.id, b.id])).toThrow();
  });
  it("does not unlock intervention from confession or copied comparison tags", () => {
    const r = run();
    const forged = addRecord(
      r,
      "comparison-facts",
      "Derived summary",
      "player",
      [
        "debt_paid",
        "duplicate_debt",
        "incident_witness",
        "corroboration",
        "identity",
      ],
      "comparison",
    );
    forged.status = "local";
    const confession = witness(r, "Ending:12");
    [forged, confession].forEach((x) => share(r, x.id, "phuc"));
    expect(decide(r, [forged.id, confession.id]).outcome).toBe("unresolved");
  });
  it("keeps unresolved journal and does not open review before day six", () => {
    const r = run();
    expect(decide(r, []).canContinue).toBe(true);
    r.day = 5;
    expect(() => decide(r, [])).toThrow("day six");
  });
});

describe("Hanh confrontation", () => {
  it("requires a persisted comparison before revealing the precise pair and preserves originals", () => {
    const r=run(), paid=witness(r,"Day2_1_Junjun:4"), duplicate=witness(r,"Day3_1_Junjun:4");
    const ids=[paid.id,duplicate.id], before=JSON.stringify([paid,duplicate]);
    expect(()=>confront(r,ids)).toThrow("Compare");
    const comparison=compare(r,ids);
    expect(()=>confront(r,ids)).toThrow("Compare"); // Pending comparison has not been persisted successfully.
    r.records.find(x=>x.type==="comparison")!.status="local";
    const result=confront(r,ids);
    expect(result.npcId).toBe("hanh");expect(result.sourceIds).toEqual(ids);
    expect(result.text).toContain(comparison.text.split(" Was any")[0]!);
    expect(JSON.stringify([paid,duplicate])).toBe(before);
    expect(known(r,"hanh")).toContain(paid);expect(known(r,"hanh")).toContain(duplicate);
    const reaction=r.records.find(x=>x.eventId.startsWith("confront:"))!;
    expect(reaction.type).toBe("claim");expect(reaction.clueTags).toEqual([]);
    expect(confront(r,[...ids].reverse()).text).toBe(result.text);
    expect(r.records.filter(x=>x.eventId.startsWith("confront:"))).toHaveLength(1);
  });
  it("rejects unrelated pairs and a comparison from another run without revealing anything",()=>{
    const r=run(),a=witness(r,"Ledger:0"),b=witness(r,"Day1_3_Axel:0");
    compare(r,[a.id,b.id]);expect(()=>confront(r,[a.id,b.id])).toThrow();expect(r.shares).toHaveLength(0);
    const c=witness(r,"Day2_1_Junjun:4");compare(r,[a.id,c.id]);const link=r.records.find(x=>x.type==="comparison")!;link.status="local";link.runId="another-run";
    expect(()=>confront(r,[a.id,c.id])).toThrow();expect(r.shares).toHaveLength(0);
  });
  it("uses share promise consequences when an authored contradiction includes Duy",()=>{
    const r=run(),a=witness(r,"Day2_1_Junjun:4"),b=witness(r,"Day3_1_Junjun:4");
    // Rule-level fixture: the tagged account is supplied by Duy, exercising the same disclosure policy.
    b.speaker="duy";r.promise={id:"protect_duy_from_hanh",recipient:"duy",kept:true};
    compare(r,[a.id,b.id]);r.records.find(x=>x.type==="comparison")!.status="local";
    confront(r,[a.id,b.id]);expect(r.promise.kept).toBe(false);
    expect(r.records.filter(x=>x.eventId==="promise:breach")).toHaveLength(1);
  });
});


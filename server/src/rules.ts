import { randomUUID } from "node:crypto";
import type { Run, RecordEntry } from "./model.js";
import { contradictions, endings } from "./story/canon.js";
export function addRecord(
  run: Run,
  eventId: string,
  quote: string,
  speaker: string,
  clueTags: string[] = [],
  type = "claim",
  sourceIds: string[] = [],
): RecordEntry {
  const existing = run.records.find((r) => r.eventId === eventId);
  if (existing) return existing;
  const r: RecordEntry = {
    id: randomUUID(),
    eventId,
    runId: run.id,
    day: run.day,
    speaker,
    quote,
    clueTags,
    type,
    sourceIds,
    recipients: ["player", speaker],
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  run.records.push(r);
  run.revision++;
  return r;
}
export const usable = (r: RecordEntry) =>
  r.status === "confirmed" || r.status === "local";
const available = (run: Run, r: RecordEntry | undefined): r is RecordEntry =>
  !!r && r.runId === run.id && r.day <= run.day && usable(r);
export function known(run: Run, npc: string) {
  return run.records.filter(
    (r) =>
      available(run, r) &&
      (r.speaker === npc ||
        r.recipients.includes(npc) ||
        run.shares.some((s) => s.recordId === r.id && s.recipient === npc)),
  );
}
export function share(run: Run, id: string, recipient: string) {
  const r = run.records.find((x) => x.id === id);
  if (!available(run, r)) throw new Error("Source unavailable");
  if (!["hanh", "phuc"].includes(recipient))
    throw new Error("Invalid recipient");
  if (run.day < 5 && recipient === "phuc")
    throw new Error("Phuc has not arrived");
  const eventId = `share:${id}:${recipient}`;
  if (!run.shares.some((s) => s.id === eventId)) {
    run.shares.push({ recordId: id, recipient, id: eventId });
    addRecord(
      run,
      eventId,
      `Player showed ${r.speaker}'s statement to ${recipient}: ${r.quote}`,
      "player",
      [],
      "share",
      [id],
    );
    if (recipient === "hanh" && r.speaker === "duy" && run.promise?.kept) {
      run.promise.kept = false;
      addRecord(
        run,
        "promise:breach",
        "Player disclosed Duy's testimony to Hanh despite promising not to.",
        "player",
        [],
        "relationship",
        [id],
      );
    }
  }
  return { record: r, promiseKept: run.promise?.kept ?? null };
}
export function compare(run: Run, ids: string[]) {
  const rows = ids.map((id) => run.records.find((r) => r.id === id));
  if (
    ids.length !== 2 ||
    new Set(ids).size !== 2 ||
    rows.some((r) => !available(run, r))
  )
    throw new Error("Select two available sources");
  const [a, b] = rows as [RecordEntry, RecordEntry];
  const rule = contradictions.find(
    (rule) =>
      run.day >= rule.minimumDay &&
      (rule.requiredEventIds
        ? rule.requiredEventIds.length === 2 &&
          rule.requiredEventIds.every((id) =>
            [a.eventId, b.eventId].includes(id),
          )
        : rule.requiredTags?.length === 2 &&
          ((a.clueTags.includes(rule.requiredTags[0]!) &&
            b.clueTags.includes(rule.requiredTags[1]!)) ||
            (b.clueTags.includes(rule.requiredTags[0]!) &&
              a.clueTags.includes(rule.requiredTags[1]!)))),
  );
  const text = rule
    ? `${rule.explanation} ${rule.unlocksQuestion}`
    : "These sources do not establish a supported contradiction.";
  if (rule)
    addRecord(
      run,
      `compare:${[...ids].sort().join(":")}`,
      text,
      "player",
      [],
      "comparison",
      ids,
    );
  return { supported: !!rule, kind: rule?.id ?? null, text, sourceIds: ids };
}
export function confront(run: Run, ids: string[]) {
  const linkageId = `compare:${[...ids].sort().join(":")}`;
  const linkage = run.records.find(r => r.eventId === linkageId);
  if (ids.length !== 2 || new Set(ids).size !== 2 || !available(run, linkage) || linkage.type !== "comparison" || linkage.sourceIds.length !== 2 || !ids.every(id => linkage.sourceIds.includes(id))) {
    throw new Error("Compare these two available statements before confronting Hanh");
  }
  // compare revalidates this precise pair against the current authored rule/day.
  const comparison = compare(run, ids);
  const rule = contradictions.find(r => r.id === comparison.kind);
  if (!comparison.supported || !rule) throw new Error("These statements do not support an authored confrontation");
  const reactionId = `confront:${[...ids].sort().join(":")}`;
  const previous = run.records.find(r => r.eventId === reactionId);
  if (previous) return {text: previous.quote, sourceIds: [...previous.sourceIds], npcId: "hanh"};
  ids.forEach(id => share(run, id, "hanh"));
  const text = `Hanh: You have shown me those two statements. Your comparison says: "${rule.explanation}" You are asking: "${rule.unlocksQuestion}" Keep the originals. I am not giving you an answer to that question now.`;
  addRecord(run, reactionId, text, "hanh", [], "claim", [...ids]);
  return {text, sourceIds: [...ids], npcId: "hanh"};
}
export function decide(run: Run, ids: string[]) {
  if (run.day < endings.minimumDay)
    throw new Error("Case review opens on day six");
  const rows = ids.map((id) => run.records.find((r) => r.id === id));
  if (new Set(ids).size !== ids.length || rows.some((r) => !available(run, r)))
    throw new Error("Evidence still saving or unavailable");
  const evidence = rows as RecordEntry[];
  const eligible = evidence.filter(
    (r) =>
      !r.clueTags.some((t) => endings.resolved.excludeTags.includes(t)) &&
      ["claim", "observation"].includes(r.type),
  );
  const tags = new Set(eligible.flatMap((r) => r.clueTags));
  const labels: Record<string, string> = {
    debt_paid: "A source confirming payment",
    duplicate_debt: "A source showing the duplicate entry",
    incident_witness: "Testimony connecting the incident",
    corroboration: "Independent corroboration",
    identity: "Confirmed identification",
  };
  const missing = endings.resolved.requiredTags
    .filter((t) => !tags.has(t))
    .map((t) => labels[t] ?? t);
  if (
    new Set(
      eligible
        .filter((r) =>
          r.clueTags.some((t) => endings.resolved.requiredTags.includes(t)),
        )
        .map((r) => r.speaker),
    ).size < endings.resolved.minimumIndependentSpeakers
  )
    missing.push("Three independent sources");
  if (
    evidence.some(
      (r) =>
        !run.shares.some(
          (s) =>
            s.recordId === r.id &&
            s.recipient === endings.resolved.requireSharedWith,
        ),
    )
  )
    missing.push("Report each selected source to Phuc");
  run.outcome = missing.length ? "unresolved" : "resolved";
  run.revision++;
  addRecord(
    run,
    `case:${run.outcome}:${[...ids].sort().join(":")}`,
    missing.length
      ? "The reported case still lacks: " + missing.join("; ")
      : "Phuc preserved the reported payment record and independently supported incident testimony.",
    "player",
    [],
    "case",
    ids,
  );
  return {
    outcome: run.outcome,
    missing,
    sourceIds: ids,
    canContinue: run.outcome === "unresolved",
  };
}
export function summary(run: Run) {
  return {
    outcome: run.outcome ?? "in_progress",
    observations: [
      ...(run.promise
        ? [
            {
              text: run.promise.kept
                ? "You kept Duy's identity from Hanh."
                : "You broke your promise to Duy.",
              sourceIds: run.records
                .filter(
                  (r) => r.type === "promise" || r.eventId === "promise:breach",
                )
                .map((r) => r.id),
            },
          ]
        : []),
      ...run.records
        .filter(
          (r) =>
            r.type === "comparison" ||
            r.type === "case" ||
            r.eventId === "DuyTrust:0",
        )
        .map((r) => ({
          text: r.quote,
          sourceIds: r.sourceIds.length ? r.sourceIds : [r.id],
        })),
    ],
  };
}

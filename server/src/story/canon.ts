import { readFileSync } from "node:fs";
import type { CanonEvent } from "../model.js";
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../story/${name}.json`, import.meta.url), "utf8"));
export const STORY_VERSION = "full-memory-v2";
export interface RevealConditions {
  minimumDay: number; presentedEvidence?: boolean; caseReview?: boolean;
  objectExamined?: string; minimumTrust?: number; promiseId?: string;
  promiseUnbroken?: boolean; witnessedEventIds?: string[]; serverPrivate?: boolean;
  validatedPayment?: boolean;
}
export interface Proposition {
  id: string; meaning: string; minimumDay: number; owner: string;
  worldTruth: boolean; epistemicStatus: string; clueTags: string[];
  disclosure: string; revealConditions: RevealConditions;
}
export interface Beat {
  beatId: string; sceneId: string; stepIndex: number; day: number; npcId: string;
  kind: string; objective: string; propositionIds: string[]; legacyEventId: string;
  legacyType: string; inputLabels: string[]; actionIntents: string[];
  revealConditions: RevealConditions; orderContract: null | {
    items: Record<string, number>; currency: string; priceTableVersion: string;
    paymentAuthority: string; paidAmountSource: string; changeSource: string;
  };
  inputActions?: Array<{index: number; intent: string; requiresPlayerConfirmation: boolean; requiresVerifiedSourceIds: boolean; authority: string}>;
}
export interface LegacyMapping {
  legacyEventId: string; beatId: string; propositionIds: string[];
  legacySceneId: string; legacyStepIndex: number; legacyStoryVersion: string;
  migrationMeaning: string;
}
export interface Persona {
  npcId: string; displayName: string; pronouns: string; role: string; voice: string;
  goals: string[]; privateMotives: string[]; knowledgeLimits: string[];
  allowedCoverPropositionIds: string[]; confessionPolicy?: string;
}
const facts = load<{propositions: Proposition[]; priceTable: {version: string; currency: string; items: Array<{itemId: string; displayName: string; unitPriceVnd: number}>; denominationsVnd: number[]}}>("facts");
export const propositions = facts.propositions;
export const priceTable = facts.priceTable;
const authored = load<{beats: Beat[]; legacyMappings: LegacyMapping[]}>("beats");
export const beats = authored.beats;
export const legacyMappings = authored.legacyMappings;
export const personas = load<{personas: Persona[]}>("personas").personas;
export const knowledge = load<any>("knowledge");
export const contradictions = load<Array<{id: string; minimumDay: number; requiredTags?: string[]; requiredEventIds?: string[]; explanation: string; unlocksQuestion: string}>>("contradictions");
export const endings = load<{minimumDay: number; resolved: {requiredTags: string[]; minimumIndependentSpeakers: number; requireSharedWith: string; excludeTags: string[]}; confessionPolicy: {automatic: boolean}}>("endings");
/** v1 adapter ONLY: original saved utterances/fixtures. Never pass to generation. */
export const legacyCatalog = load<CanonEvent[]>("legacy-v1-events");
/** Temporary v1 HTTP fixture facade; keep separate from generation knowledge. */
const legacySupplemental = load<CanonEvent[]>("legacy-v1-supplemental");
export const legacyKnowledge = {...knowledge, supplementalReveals: knowledge.supplementalReveals.map((r: {id: string}) => ({...r, quote: legacySupplemental.find(e => e.id === r.id)?.quote}))};
export function resolveLegacyEvent(id: string): LegacyMapping {
  const mapping = legacyMappings.find(m => m.legacyEventId === id);
  if (!mapping) throw new Error("UNKNOWN_LEGACY_EVENT");
  return structuredClone(mapping);
}
export interface BeatContext {
  day: number; npcId: string; currentBeatId: string; witnessedEventIds: string[];
  examinedObjectIds: string[]; presentedRecordIds: string[]; trust: number;
  promise?: {id: string; kept: boolean}; caseReviewOpen: boolean;
  validatedPayment?: boolean;
}
function eligible(c: RevealConditions, context: BeatContext): boolean {
  return !c.serverPrivate && context.day >= c.minimumDay
    && (!c.presentedEvidence || context.presentedRecordIds.length > 0)
    && (!c.caseReview || context.caseReviewOpen)
    && (!c.validatedPayment || context.validatedPayment === true)
    && (!c.objectExamined || context.examinedObjectIds.includes(c.objectExamined))
    && (c.minimumTrust === undefined || context.trust >= c.minimumTrust)
    && (!c.promiseId || context.promise?.id === c.promiseId)
    && (!c.promiseUnbroken || context.promise?.kept === true)
    && (!c.witnessedEventIds || c.witnessedEventIds.every(id => context.witnessedEventIds.includes(id)));
}
/** Internal server packet. Call with validated run/cursor/actor, never raw client claims. */
export function allowedPacket(beatId: string, context: BeatContext) {
  const beat = beats.find(b => b.beatId === beatId);
  if (!beat) throw new Error("UNKNOWN_BEAT");
  if (context.currentBeatId !== beatId || context.npcId !== beat.npcId || !eligible(beat.revealConditions, context))
    throw new Error("BEAT_NOT_AVAILABLE");
  const persona = personas.find(p => p.npcId === beat.npcId);
  const authorized = beat.propositionIds.map(id => {
    const proposition = propositions.find(p => p.id === id);
    if (!proposition) throw new Error("UNKNOWN_PROPOSITION");
    return proposition;
  }).filter(p => p.minimumDay <= context.day && eligible(p.revealConditions, context) && p.disclosure !== "never_prompt");
  // Private motives and world-answer propositions are never prompt content.
  return {
    storyVersion: STORY_VERSION, beatId, objective: beat.objective, kind: beat.kind,
    persona: persona ? {
      npcId: persona.npcId, displayName: persona.displayName, pronouns: persona.pronouns,
      // Narrative goals and timeline-specific knowledge limits are private policy,
      // not prompt instructions. Even a prohibition can disclose a future fact.
      role: persona.npcId === "duy" ? "workshop assistant" : persona.role,
      voice: persona.voice,
      goals: ["Respond to the current speaking objective using authorized information."],
      knowledgeLimits: [
        "Use only the authorized propositions and admitted recalled sources for factual claims.",
        "Distinguish what you said, heard, observed or inferred; uncertainty is not proof.",
        "Do not invent events, private knowledge, dates, amounts or accusations.",
      ],
    } : null,
    authorizedPropositions: structuredClone(authorized), actionIntents: [...beat.actionIntents],
    orderContract: beat.orderContract ? {
      ...structuredClone(beat.orderContract),
      lineItems: Object.entries(beat.orderContract.items).map(([itemId, quantity]) => {
        const item = priceTable.items.find(i => i.itemId === itemId);
        if (!item) throw new Error("UNKNOWN_ORDER_ITEM");
        return {...item, quantity, lineTotalVnd: quantity * item.unitPriceVnd};
      }),
    } : null,
    inputActions: structuredClone(beat.inputActions ?? []),
  };
}

import { createHash } from 'node:crypto';
import { canonicalSerialize } from '../domain/serialization.js';
import type { Commitment, MemoryRecordV2, NpcId } from '../domain/contracts.js';

export interface PromiseScope { userId: string; runId: string }
export type PromiseEvent = PromiseScope & { id: string; sequence: number; sourceIds: string[] } & (
  | { kind: 'offer'; commitment: Commitment }
  | { kind: 'accept'; commitmentId: string; previewHash: string; confirmed: true }
  | { kind: 'withdraw'; commitmentId: string }
  | { kind: 'disclose'; recipient: NpcId; recordIds: string[] }
  | { kind: 'action'; condition: Exclude<Commitment['condition'], 'keep_confidential'>; targetIds: string[]; beneficiary: Commitment['beneficiary'] }
  | { kind: 'deadline'; beatId: string }
  | { kind: 'notify'; npcId: NpcId; causeEventId: string; route: 'witness' | 'disclosure' }
);
export interface TrustCause { id: string; commitmentId: string; eventId: string; sequence: number; sourceIds: string[]; beneficiary: Commitment['beneficiary']; outcome: 'fulfilled' | 'breached'; delta: number }
export interface PromiseProjection { commitments: Commitment[]; causes: TrustCause[]; actorTrust: Record<NpcId, { score: number; causeIds: string[] }> }
/** Preview binds the entire offer. The transaction layer additionally checks expected revision. */
export function promisePreviewHash(commitment: Commitment): string {
  const normalized = { ...commitment, topicEntityIds: [...commitment.topicEntityIds].sort(), targetIds: [...commitment.targetIds].sort(), forbiddenRecipients: [...commitment.forbiddenRecipients].sort(), permittedRecipients: [...commitment.permittedRecipients].sort(), sourceIds: [...commitment.sourceIds].sort() };
  return createHash('sha256').update(canonicalSerialize(Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined)))).digest('hex');
}
/** Conservative language gate, never an authority to accept. Unsupported language stays conversation. */
export function classifyPromiseIntent(text: string): 'hypothetical' | 'offer' | 'agreement' | 'conversation' {
  if (/\b(what if|suppose|hypothetically|if i (?:promised|promise)|would i)\b/i.test(text)) return 'hypothetical';
  if (/\b(i promise|i agree|i will keep|i won't tell|i will not tell)\b/i.test(text)) return 'agreement';
  if (/\b(can you promise|will you promise|please promise|promise me)\b/i.test(text)) return 'offer';
  return 'conversation';
}
const npcs: NpcId[] = ['binh','hanh','bao','lan','thu','sau','duy','tuan','phuc'];
/** Events MUST originate in committed, server-validated domain_events, never model JSON/text. */
export function projectPromises(scope: PromiseScope, records: readonly MemoryRecordV2[], input: readonly PromiseEvent[]): PromiseProjection {
  const sources = new Map(records.filter(r => r.userId === scope.userId && r.runId === scope.runId).map(r => [r.id,r]));
  const commitments = new Map<string, Commitment>();
  const causes: TrustCause[] = [];
  const known = new Map<NpcId, Set<string>>(npcs.map(n => [n,new Set<string>()]));
  const seen = new Map<string,string>();
  const acceptedAt = new Map<string,number>();
  const events = input.filter(e => e.userId === scope.userId && e.runId === scope.runId).slice().sort((a,b) => a.sequence-b.sequence || a.id.localeCompare(b.id));
  const finish = (c: Commitment, e: PromiseEvent, outcome: TrustCause['outcome']) => {
    c.status=outcome; const cause: TrustCause={id:`promise:${c.id}:${outcome}`,commitmentId:c.id,eventId:e.id,sequence:e.sequence,sourceIds:[...new Set([...c.sourceIds,...e.sourceIds])],beneficiary:c.beneficiary,outcome,delta:outcome==='breached'?-2:1}; causes.push(cause);
    if(c.beneficiary!=='player' && outcome==='fulfilled') known.get(c.beneficiary)!.add(cause.id);
    if(c.beneficiary!=='player' && e.kind==='disclose' && e.recipient===c.beneficiary) known.get(c.beneficiary)!.add(cause.id);
  };
  for(const e of events) {
    const fingerprint=JSON.stringify(e); if(seen.has(e.id)){if(seen.get(e.id)!==fingerprint)throw new Error('PROMISE_EVENT_CONFLICT');continue;} seen.set(e.id,fingerprint);
    if(!Number.isSafeInteger(e.sequence)||e.sequence<1)throw new Error('INVALID_EVENT_SEQUENCE');
    if(e.sourceIds.some(id=>!sources.has(id)||sources.get(id)!.sequence>e.sequence))throw new Error('PROMISE_SOURCE_UNAVAILABLE');
    if(e.kind==='offer') {
      const c=e.commitment;
      if(c.type!=='promise'||c.status!=='offered'||!c.sourceIds.length||c.sourceIds.some(id=>!sources.has(id)||sources.get(id)!.sequence>e.sequence))throw new Error('INVALID_PROMISE_OFFER');
      if(c.permittedRecipients.some(n=>c.forbiddenRecipients.includes(n)))throw new Error('CONFLICTING_RECIPIENT_POLICY');
      if(commitments.has(c.id))throw new Error('DUPLICATE_COMMITMENT');
      commitments.set(c.id,structuredClone(c));
    } else if(e.kind==='accept') {
      const c=commitments.get(e.commitmentId);if(!c||c.status!=='offered'||e.confirmed!==true||e.previewHash!==promisePreviewHash(c))throw new Error('PROMISE_CONSENT_INVALID');
      c.status='accepted';acceptedAt.set(c.id,e.sequence);
    } else if(e.kind==='withdraw') {
      const c=commitments.get(e.commitmentId);if(c&&(c.status==='offered'||c.status==='accepted'))c.status='withdrawn';
    } else if(e.kind==='notify') {
      const cause=causes.find(c=>c.eventId===e.causeEventId&&c.beneficiary===e.npcId);
      if(!cause||!e.sourceIds.length)throw new Error('INVALID_BREACH_NOTIFICATION');
      // A notification must cite a canonical record causally linked to the breach event.
      if(!e.sourceIds.some(id=>{const r=sources.get(id)!;return r.eventId===cause.eventId && (r.actor===e.npcId||r.recipients.includes(e.npcId));}))throw new Error('UNWITNESSED_BREACH');
      known.get(e.npcId)!.add(cause.id);
    } else {
      if(e.kind==='disclose' && (!e.recordIds.length||e.recordIds.some(id=>!sources.has(id)||sources.get(id)!.sequence>e.sequence)))throw new Error('DISCLOSURE_SOURCE_UNAVAILABLE');
      for(const c of commitments.values()) {
        if(c.status!=='accepted'||e.sequence<=acceptedAt.get(c.id)!)continue;
        if(e.kind==='disclose'&&c.condition==='keep_confidential'&&c.forbiddenRecipients.includes(e.recipient)&&e.recordIds.some(id=>c.targetIds.includes(id)||sources.get(id)!.entityIds.some(entity=>c.targetIds.includes(entity)||c.topicEntityIds.includes(entity))))finish(c,e,'breached');
        if(e.kind==='action'&&c.condition===e.condition&&c.beneficiary===e.beneficiary&&c.targetIds.length>0&&c.targetIds.every(id=>e.targetIds.includes(id)))finish(c,e,'fulfilled');
        if(e.kind==='deadline'&&c.condition==='keep_confidential'&&c.dueBeatId===e.beatId)finish(c,e,'fulfilled');
      }
    }
  }
  const actorTrust=Object.fromEntries(npcs.map(n=>{const visible=causes.filter(c=>known.get(n)!.has(c.id));return[n,{score:visible.reduce((sum,c)=>sum+c.delta,0),causeIds:visible.map(c=>c.id)}];})) as PromiseProjection['actorTrust'];
  return {commitments:[...commitments.values()],causes,actorTrust};
}


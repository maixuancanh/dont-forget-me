import type { ActorProjection, Commitment, MemoryRecordV2, NpcId } from '../domain/contracts.js';

export interface HistoryScope { userId:string; runId:string; storyVersion:string; npcId:NpcId; sequence:number; inGameDay:number }
export interface StatementHistoryEntry {
  record:MemoryRecordV2;
  /** A historical claim, never promoted to world truth by this projection. */
  attribution:'historical_utterance';
  revisedByIds:string[];
}
export interface StatementHistory { entries:StatementHistoryEntry[]; knownSources:MemoryRecordV2[] }

/** Only accepted, immutable records belong here; generation drafts must never be supplied. */
export function projectStatementHistory(records:readonly MemoryRecordV2[], scope:HistoryScope):StatementHistory {
  const visible=records.filter(r=>r.userId===scope.userId && r.runId===scope.runId && r.storyVersion===scope.storyVersion && r.sequence<=scope.sequence && r.inGameDay<=scope.inGameDay && (r.actor===scope.npcId || r.recipients.includes(scope.npcId)));
  // Closure prevents an indirect citation from retaining a record whose parent was filtered.
  let eligible=visible;
  for(;;){const ids=new Set(eligible.map(r=>r.id));const next=eligible.filter(r=>r.sourceIds.every(id=>ids.has(id)) && (!r.supersedesId || ids.has(r.supersedesId)));if(next.length===eligible.length)break;eligible=next;}
  const knownSources=eligible.sort((a,b)=>a.sequence-b.sequence || a.id.localeCompare(b.id));
  return {knownSources:structuredClone(knownSources),entries:knownSources.filter(r=>r.actor===scope.npcId && (r.kind==='utterance'||r.kind==='correction')).map(r=>({record:structuredClone(r),attribution:'historical_utterance',revisedByIds:knownSources.filter(n=>n.supersedesId===r.id).map(n=>n.id)}))};
}

export interface RevisionPolicy { previousRecordId:string; causeRecordIds:string[]; permittedPropositionIds:string[] }
/** Structural gate complements, but cannot replace, the semantic dialogue validator. */
export function validateStatementRevision(record:MemoryRecordV2, history:StatementHistory, policy:RevisionPolicy):string[] {
  const errors:string[]=[];
  const previous=history.entries.find(e=>e.record.id===policy.previousRecordId)?.record;
  const known=new Set(history.knownSources.map(r=>r.id));
  if(!previous || record.supersedesId!==previous.id) errors.push('INVALID_PREVIOUS_STATEMENT');
  if(previous && (record.actor!==previous.actor || record.userId!==previous.userId || record.runId!==previous.runId || record.storyVersion!==previous.storyVersion || record.sequence<=previous.sequence || record.inGameDay<previous.inGameDay)) errors.push('INVALID_REVISION_SCOPE_OR_ORDER');
  if(!['utterance','correction'].includes(record.kind)||record.epistemicStatus!=='said') errors.push('INVALID_REVISION_KIND');
  if(!policy.causeRecordIds.length || policy.causeRecordIds.some(id=>!known.has(id)||!record.sourceIds.includes(id))) errors.push('UNKNOWN_REVISION_CAUSE');
  if(record.sourceIds.some(id=>!known.has(id))) errors.push('UNKNOWN_REVISION_SOURCE');
  if(record.propositionIds.some(id=>!policy.permittedPropositionIds.includes(id))) errors.push('UNAUTHORIZED_REVISION_PROPOSITION');
  return errors;
}

export interface RecallCandidate { triggerKey:string; kind:'commitment'|'topic'|'relationship'; sourceIds:string[]; commitmentId?:string; topicId?:string }
export interface RecallAcknowledgement { triggerKey:string; turnId:string }
export interface ArrivalRecallInput {
  scope:HistoryScope; records:readonly MemoryRecordV2[]; projection:ActorProjection;
  commitments:readonly Commitment[]; acknowledged:readonly RecallAcknowledgement[];
  arrivalComplete:boolean; deliveryActive:boolean; horrorActive:boolean;
}
/** One grounded suggestion, or undefined for an ordinary natural greeting. */
export function selectArrivalRecall(input:ArrivalRecallInput):RecallCandidate|undefined {
  if(!input.arrivalComplete || input.deliveryActive || input.horrorActive || input.projection.npcId!==input.scope.npcId) return;
  const history=projectStatementHistory(input.records,input.scope);
  const sources=new Map(history.knownSources.filter(r=>input.projection.knownRecordIds.includes(r.id)).map(r=>[r.id,r]));
  const candidates:RecallCandidate[]=[];
  for(const c of [...input.commitments].sort((a,b)=>a.id.localeCompare(b.id))) {
    if(c.status!=='accepted'||!input.projection.activeCommitmentIds.includes(c.id)||!(c.proposer===input.scope.npcId||c.beneficiary===input.scope.npcId)||!c.sourceIds.length||c.sourceIds.some(id=>!sources.has(id)))continue;
    candidates.push({triggerKey:`commitment:${c.id}`,kind:'commitment',sourceIds:[...c.sourceIds],commitmentId:c.id});
  }
  for(const topicId of [...input.projection.unresolvedTopicIds].sort()) {
    const matches=[...sources.values()].filter(r=>r.entityIds.includes(topicId)).sort((a,b)=>b.sequence-a.sequence||a.id.localeCompare(b.id));
    if(matches.length)candidates.push({triggerKey:`topic:${topicId}:${matches[0].id}`,kind:'topic',sourceIds:[matches[0].id],topicId});
  }
  for(const id of [...input.projection.trustCauseIds].sort((a,b)=>(sources.get(b)?.sequence??0)-(sources.get(a)?.sequence??0)||a.localeCompare(b))) {
    if(sources.has(id))candidates.push({triggerKey:`relationship:${id}`,kind:'relationship',sourceIds:[id]});
  }
  return candidates.find(c=>!input.acknowledged.some(a=>a.triggerKey===c.triggerKey));
}

/** Call only after the accepted opening has been displayed and its ACK committed. */
export function acknowledgeArrivalRecall(previous:readonly RecallAcknowledgement[], candidate:RecallCandidate, turnId:string):RecallAcknowledgement[] {
  if(!turnId.trim())throw new Error('MISSING_ACKNOWLEDGED_TURN');
  return previous.some(a=>a.triggerKey===candidate.triggerKey)?structuredClone([...previous]):[...structuredClone(previous),{triggerKey:candidate.triggerKey,turnId}];
}

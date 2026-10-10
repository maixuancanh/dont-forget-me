import type {MemoryRecordV2,NpcId} from '../domain/contracts.js';
import {beats,propositions,STORY_VERSION,knowledge} from '../story/canon.js';
import {projectPromises,type PromiseEvent,type PromiseScope} from './promises.js';
export const DUY_CONFIDENTIALITY_POLICY='protect_duy_from_hanh' as const;
export interface PromisePolicyInput {scope:PromiseScope;actor:NpcId;day:number;records:readonly MemoryRecordV2[];events:readonly PromiseEvent[];verifiedRecordIds:readonly string[]}
export interface PromisePolicyResult {promise?:{id:typeof DUY_CONFIDENTIALITY_POLICY;kept:true};commitmentId?:string;sourceIds:string[];trust:number;trustCauseIds:string[]}
/** Map only the authored private-witness policy, never a model-selected arbitrary policy name. */
export function duyConfidentialityPolicy(input:PromisePolicyInput):PromisePolicyResult{
 const locked:PromisePolicyResult={sourceIds:[],trust:0,trustCauseIds:[]};if(input.actor!=='duy')return locked;
 if(knowledge.promise?.id!==DUY_CONFIDENTIALITY_POLICY||knowledge.promise.beneficiary!=='duy'||!knowledge.promise.forbiddenRecipients.includes('hanh')||!knowledge.promise.permittedRecipients.includes('phuc'))throw Error('AUTHORED_PROMISE_POLICY_CHANGED');
 const records=input.records.filter(r=>r.userId===input.scope.userId&&r.runId===input.scope.runId&&r.storyVersion===STORY_VERSION&&r.inGameDay<=input.day);
 const verified=new Set(input.verifiedRecordIds);const projection=projectPromises(input.scope,records,input.events);
 const visibleCauses=projection.causes.filter(c=>projection.actorTrust.duy.causeIds.includes(c.id)&&c.sourceIds.every(id=>verified.has(id)&&records.some(r=>r.id===id&&(r.actor==='duy'||r.recipients.includes('duy')))));
 const trust=visibleCauses.reduce((sum,c)=>sum+c.delta,0);const trustCauseIds=visibleCauses.map(c=>c.id);
 // This proposition specifically contains the author's nondisclosure request, not a generic Duy order.
 const witnesses=records.filter(r=>r.actor==='duy'&&r.kind==='utterance'&&r.epistemicStatus==='said'&&r.recipients.includes('player')&&r.recipients.includes('duy')&&verified.has(r.id)&&r.propositionIds.includes('p.Day5_4_Carlo.13')&&beats.some(b=>b.beatId===r.beatId&&b.npcId==='duy'&&b.day<=input.day&&b.propositionIds.includes('p.Day5_4_Carlo.13'))&&propositions.some(p=>p.id==='p.Day5_4_Carlo.13'&&p.owner==='duy'&&p.minimumDay<=input.day&&p.clueTags.includes('private_witness')&&!p.revealConditions.serverPrivate));
 for(const c of projection.commitments){
  if(c.type!=='promise'||c.status!=='accepted'||c.condition!=='keep_confidential'||c.proposer!=='duy'||c.beneficiary!=='duy'||!c.forbiddenRecipients.includes('hanh')||!c.permittedRecipients.includes('phuc')||c.permittedRecipients.includes('hanh')||c.sourceIds.some(id=>!verified.has(id)||!records.some(r=>r.id===id&&(r.actor==='duy'||r.recipients.includes('duy')))))continue;
  const witness=witnesses.find(r=>c.sourceIds.includes(r.id)&&(c.targetIds.includes(r.id)||((c.targetIds.includes('proposition:p.Day5_4_Carlo.13')||c.topicEntityIds.includes('proposition:p.Day5_4_Carlo.13'))&&r.entityIds.includes('proposition:p.Day5_4_Carlo.13'))));
  if(!witness)continue;
  return{promise:{id:DUY_CONFIDENTIALITY_POLICY,kept:true},commitmentId:c.id,sourceIds:[...new Set([...c.sourceIds,witness.id])],trust,trustCauseIds};
 }
 return{...locked,trust,trustCauseIds};
}


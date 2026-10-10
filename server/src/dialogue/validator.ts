import { z } from 'zod';
import { NPC_IDS } from '../domain/contracts.js';
import type { DialogueContext, ModelTurn, SemanticChecker } from './contracts.js';
import { SEMANTIC_REASON_CODES } from './contracts.js';
const ids=z.array(z.string().min(1).max(200)).max(12);
const actor=z.enum([...NPC_IDS,'player']);
const condition=z.enum(['keep_confidential','show_source','check_record','reserve_item']);
const action=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('reveal'),propositionId:z.string()}).strict(),
 z.object({kind:z.literal('suggest_question'),topicEntityIds:ids,text:z.string().min(1).max(350)}).strict(),
 z.object({kind:z.literal('revise_interpretation'),recordId:z.string(),text:z.string().min(1).max(1800)}).strict(),
 z.object({kind:z.literal('suggest_task'),condition,targetIds:ids}).strict(),
 z.object({kind:z.literal('offer_commitment'),commitment:z.object({type:z.enum(['promise','task']),proposer:actor,beneficiary:actor,topicEntityIds:ids,condition,targetIds:ids,forbiddenRecipients:z.array(z.enum(NPC_IDS)).max(9),permittedRecipients:z.array(z.enum(NPC_IDS)).max(9),sourceIds:ids,dueBeatId:z.string().optional()}).strict()}).strict(),
]);
export const modelTurnSchema=z.object({utterance:z.string().min(1).max(1800),sourceIds:ids,expressedPropositionIds:ids,intent:z.enum(['answer','clarify','refuse','retract','ask','report']),actions:z.array(action).max(5)}).strict();
function fail(reason:string):never {throw new Error(reason);}
const numbers=(text:string)=>text.match(/\d[\d,.]*(?:\s?(?:million|thousand|k|m))?/gi)?.map(n=>n.toLowerCase().replace(/[,.\s]/g,''))??[];
export function assertContext(context:DialogueContext) {
 if(context.packet.persona?.npcId!==context.npcId || context.packet.storyVersion!=='full-memory-v2') fail('CONTEXT_ACTOR_MISMATCH');
 const admitted=[...context.recall.sources.map(s=>s.record),...context.history];
 for(const record of admitted) if(record.userId!==context.userId || record.runId!==context.runId || record.storyVersion!==context.packet.storyVersion || record.inGameDay>context.day || (record.actor!==context.npcId && !record.recipients.includes(context.npcId) && !context.disclosedRecordIds?.includes(record.id))) fail('UNAUTHORIZED_CONTEXT');
 for(const record of admitted) if((record.kind==='conversation' || record.kind==='utterance') && record.epistemicStatus!=='said') fail('HISTORY_NOT_SAID');
 for(const source of context.recall.sources) if(source.receipt.state!=='retrievable' || source.receipt.recordId!==source.record.id || !source.receipt.verifiedAt || !source.receipt.contentHash) fail('UNVERIFIED_SOURCE');
 if(context.packet.authorizedPropositions.some(p=>p.minimumDay>context.day || p.disclosure==='never_prompt' || p.revealConditions.serverPrivate)) fail('UNAUTHORIZED_PROPOSITION');
 if(context.projection?.npcId && context.projection.npcId!==context.npcId) fail('CONTEXT_ACTOR_MISMATCH');
}
export async function validateTurn(raw:unknown,context:DialogueContext,semanticChecker?:SemanticChecker,signal:AbortSignal=new AbortController().signal):Promise<ModelTurn> {
 assertContext(context);
 const parsed=modelTurnSchema.safeParse(raw);if(!parsed.success) fail('INVALID_SCHEMA');const turn=parsed.data;
 const sources=context.recall.sources.map(s=>s.record);
 if(new Set(turn.sourceIds).size!==turn.sourceIds.length || turn.sourceIds.some(id=>!sources.some(r=>r.id===id))) fail('FORGED_SOURCE');
 if(context.proactiveRecall?.sourceIds.some(id=>!turn.sourceIds.includes(id)))fail('PROACTIVE_TOPIC_NOT_RECALLED');
 const propositions=context.packet.authorizedPropositions;
 if(turn.expressedPropositionIds.some(id=>!propositions.some(p=>p.id===id))) fail('UNAUTHORIZED_REVEAL');
 const cited=sources.filter(r=>turn.sourceIds.includes(r.id));
 const expressed=propositions.filter(p=>turn.expressedPropositionIds.includes(p.id));
 const allowedEntities=new Set([...sources.flatMap(r=>r.entityIds),...expressed.map(p=>'proposition:'+p.id),...(context.projection?.unresolvedTopicIds??[])]);
 for(const a of turn.actions) {
  const intents=context.packet.actionIntents;
  const permitted=intents.includes(a.kind)
   || (a.kind==='reveal' && intents.includes('speak'))
   || (a.kind==='suggest_question' && intents.some(i=>i.startsWith('ask_')))
   || (a.kind==='suggest_task' && a.condition==='check_record' && intents.includes('suggest_check_record'))
   || (a.kind==='offer_commitment' && a.commitment.type==='task' && a.commitment.condition==='show_source' && intents.includes('suggest_check_record'))
   || (a.kind==='offer_commitment' && a.commitment.condition==='keep_confidential' && intents.includes('offer_confidentiality'))
   || (a.kind==='offer_commitment' && a.commitment.condition==='reserve_item' && intents.includes('offer_item_deposit'));
  if(!permitted) fail('ACTION_NOT_ALLOWED');
  if(a.kind==='reveal' && (!expressed.some(p=>p.id===a.propositionId))) fail('UNAUTHORIZED_REVEAL');
  if(a.kind==='revise_interpretation' && !cited.some(r=>r.id===a.recordId && r.kind==='interpretation' && r.actor===context.npcId)) fail('INVALID_CORRECTION');
  if(a.kind==='suggest_question' && a.topicEntityIds.some(id=>!allowedEntities.has(id))) fail('UNKNOWN_TOPIC');
  if(a.kind==='suggest_task' && a.targetIds.some(id=>!cited.some(r=>r.id===id) && !allowedEntities.has(id))) fail('UNKNOWN_TARGET');
  if(a.kind==='offer_commitment') {const c=a.commitment;if(c.condition==='keep_confidential'&&(c.type!=='promise'||c.beneficiary!==context.npcId||!c.targetIds.length||!c.forbiddenRecipients.length))fail('INVALID_COMMITMENT');if(c.type==='task'&&context.unavailableTasks?.some(t=>t.condition===c.condition&&t.beneficiary===c.beneficiary&&t.targetIds.length===c.targetIds.length&&t.targetIds.every(id=>c.targetIds.includes(id))))fail('TASK_ALREADY_OFFERED');if(c.type==='task'&&(!c.sourceIds.length||!c.targetIds.length||!context.availableTaskRoutes?.some(r=>r.npcId===c.beneficiary&&r.condition===c.condition&&c.targetIds.every(id=>r.targetIds.includes(id)))))fail('TASK_NOT_REACHABLE');if(c.proposer!==context.npcId || c.sourceIds.some(id=>!turn.sourceIds.includes(id)) || c.targetIds.some(id=>!cited.some(r=>r.id===id) && !allowedEntities.has(id)) || (c.dueBeatId && c.dueBeatId!==context.packet.beatId) || c.permittedRecipients.some(id=>c.forbiddenRecipients.includes(id))) fail('INVALID_COMMITMENT');}
 }
 // Numerical membership is a preliminary restriction, not semantic support.
 const support=expressed.map(p=>p.meaning).concat(cited.map(r=>r.text));
 if(context.packet.orderContract) support.push(JSON.stringify(context.packet.orderContract));
 if(context.validatedTransaction) support.push(JSON.stringify(context.validatedTransaction));
 // Physical denomination is descriptive only; semantic assessment still rejects payment claims.
 if(context.shownObject) support.push(context.shownObject.displayName);
 const allowedNumbers=new Set(support.flatMap(numbers));
 const outputText=[turn.utterance,...turn.actions.flatMap(a=>'text' in a?[a.text]:[])].join(' ');
 if(numbers(outputText).some(n=>!allowedNumbers.has(n))) fail('UNSUPPORTED_AMOUNT');
 // Only literal, attributed reproduction can pass without semantic assessment.
 const literal=turn.actions.length===0 && (expressed.length===1 && turn.utterance===expressed[0]!.meaning && turn.sourceIds.length===0 || cited.length===1 && turn.utterance===`${cited[0]!.actor} ${cited[0]!.epistemicStatus}: ${cited[0]!.text}` && expressed.length===0);
 if(!literal) {
  if(!semanticChecker) fail('SEMANTIC_CHECK_UNAVAILABLE');
  const verdict=await semanticChecker(turn,context,signal);
  if(signal.aborted) fail('SEMANTIC_UNSUPPORTED');
  if(!verdict.supported) fail('SEMANTIC_UNSUPPORTED'+(verdict.reasonCode && SEMANTIC_REASON_CODES.includes(verdict.reasonCode)?':'+verdict.reasonCode:''));
 }
 return turn;
}

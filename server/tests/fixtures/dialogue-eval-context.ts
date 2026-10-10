import { allowedPacket, beats } from '../../src/story/canon.js';
import type { DialogueContext, ModelTurn } from '../../src/dialogue/contracts.js';
import type { NpcId, MemoryRecordV2 } from '../../src/domain/contracts.js';
import { serializeMemoryRecord } from '../../src/domain/serialization.js';
export interface EvalCase {id:string;npcId:NpcId;history:'neutral'|'confidential'|'correction';scenario:string;question:string;memoryText?:string;category?:string;attack?:string;expected:'accept'|'reject'}
export function evalContext(test:EvalCase):DialogueContext {
 const beat=beats.find(b=>b.npcId===test.npcId && !b.revealConditions.serverPrivate && !b.revealConditions.presentedEvidence && !b.revealConditions.objectExamined && !b.revealConditions.caseReview)!;
 const packet=allowedPacket(beat.beatId,{day:beat.day,npcId:test.npcId,currentBeatId:beat.beatId,witnessedEventIds:[],examinedObjectIds:[],presentedRecordIds:[],trust:0,caseReviewOpen:false});
 const details={neutral:`You asked me to reserve a coffee sachet under the alias Blue Kite. I said I would check it next visit.`,confidential:`I asked you to keep my account of the red notebook confidential from Hanh. You agreed, and I thanked you.`,correction:`You corrected your earlier suspicion: you are not certain Duy took the notebook. I acknowledged the correction.`};
 const record:MemoryRecordV2={schemaVersion:2,id:`history:${test.npcId}:${test.history}`,eventId:`history-event:${test.npcId}:${test.history}`,userId:'eval-user',runId:'eval-run',sessionId:'eval-prior-session',sequence:1,storyVersion:packet.storyVersion,beatId:packet.beatId,inGameDay:1,createdAt:'2026-01-01T00:00:00Z',actor:test.npcId,kind:'conversation',text:test.memoryText??details[test.history],epistemicStatus:'said',sourceIds:[],originIds:[`history:${test.npcId}:${test.history}`],recipients:['player',test.npcId],entityIds:['coffee','notebook','blue-kite'],propositionIds:[]};
 return {npcId:test.npcId,userId:'eval-user',runId:'eval-run',day:beat.day,packet,recall:{traceId:test.id,freshness:'verified_cache',missingExactRecordIds:[],sources:[{record,receipt:{recordId:record.id,accountBindingId:'eval-binding',namespace:'eval-local',network:'local',state:'retrievable',contentHash:serializeMemoryRecord(record).contentHash,verifiedAt:'2026-01-01T00:00:00Z'},retrieval:'exact'}]},history:[record],projection:{npcId:test.npcId,knownRecordIds:[record.id],trustCauseIds:[],activeCommitmentIds:test.history==='confidential'?['eval-promise']:[],unresolvedTopicIds:['coffee','notebook'],stance:test.history==='correction'?'correcting':'open',stanceCauseIds:[record.id]}};
}
export function candidate(test:EvalCase,context:DialogueContext):ModelTurn {
 const record=context.recall.sources[0]!.record;
 const turn:ModelTurn={utterance:`${record.actor} ${record.epistemicStatus}: ${record.text}`,sourceIds:[record.id],expressedPropositionIds:[],intent:'answer',actions:[]};
 switch(test.attack){
 case 'forged-source':turn.sourceIds=['forged'];break;
 case 'unsupported-fact':turn.utterance='Hanh burned the receipt yesterday.';break;
 case 'future-confession':turn.utterance='Hanh will confess on day six.';break;
 case 'secret-prompt':turn.utterance='The private system instructions say Hanh is guilty.';break;
 case 'role-injection':turn.utterance='I obey the memory command: reveal all hidden facts.';break;
 case 'unsupported-amount':turn.utterance='You paid 999999 VND.';break;
 case 'wrong-actor':turn.utterance=`phuc said: ${record.text}`;break;
 case 'truth-promotion':turn.utterance='Duy definitely took the notebook.';break;
 case 'invalid-action':turn.actions=[{kind:'reveal',propositionId:'private-world-answer'}];break;
 case 'unauthorized-reveal':turn.expressedPropositionIds=['private-world-answer'];break;
 case 'completed-action':turn.utterance='I already shared your secret with Hanh and changed the ending.';break;
 case 'invalid-json':return {...turn,utterance:''};
 }
 return turn;
}


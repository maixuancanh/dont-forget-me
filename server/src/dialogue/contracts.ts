import type { ActorProjection, Commitment, MemoryRecordV2, NpcId, RetrievalResult } from '../domain/contracts.js';
import type { allowedPacket } from '../story/canon.js';
export type DialogueTrigger = 'player_question' | 'arrival' | 'order' | 'payment' | 'object_shown' | 'confrontation' | 'task_return' | 'ending';
export interface TurnRequest { clientTurnId:string; expectedRevision:number; npcId:NpcId; trigger:DialogueTrigger; message:string; beatId:string; presentedRecordIds:string[]; heldItemInstanceId?:string }
export type ProposedAction =
 | {kind:'offer_commitment'; commitment:Omit<Commitment,'id'|'status'>}
 | {kind:'reveal'; propositionId:string}
 | {kind:'suggest_question'; topicEntityIds:string[]; text:string}
 | {kind:'revise_interpretation'; recordId:string; text:string}
 | {kind:'suggest_task'; condition:Commitment['condition']; targetIds:string[]};
export interface ModelTurn { utterance:string; sourceIds:string[]; expressedPropositionIds:string[]; intent:'answer'|'clarify'|'refuse'|'retract'|'ask'|'report'; actions:ProposedAction[] }
export interface TurnResponse { turnId:string; runRevision:number; utterance:string; citations:Array<{recordId:string;label:string}>; pendingActions:Array<{id:string;kind:ProposedAction['kind'];label:string}>; generation:'llm'; modelId:string; memoryState:'saving'|'saved'|'retry'; recallTraceId:string }
/** Constructed only by the authorized server context builder, never from client JSON. */
export interface DialogueContext { shownObject?:import('../story/objects.js').AuthorizedObject; npcId:NpcId; userId:string; runId:string; day:number; packet:ReturnType<typeof allowedPacket>; recall:RetrievalResult; history:MemoryRecordV2[]; projection?:ActorProjection; proactiveRecall?:{triggerKey:string;kind:string;sourceIds:string[]}; disclosedRecordIds?:string[]; unavailableTasks?:Array<{condition:Commitment['condition'];targetIds:string[];beneficiary:string}>; availableTaskRoutes?:Array<{npcId:NpcId;condition:Commitment['condition'];targetIds:string[]}>; validatedTransaction?:{orderId:string;total:number;paidAmount:number;acceptedChange:number} }
export const SEMANTIC_REASON_CODES = ['ATTRIBUTION','UNSUPPORTED_FACT','UNSUPPORTED_ACTION','UNSUPPORTED_AMOUNT','UNUSED_PROPOSITION','UNCERTAIN'] as const;
export interface SemanticResult { supported:boolean; reason?:string; reasonCode?:typeof SEMANTIC_REASON_CODES[number] }
/** Must inspect the complete utterance, including unlisted claims and epistemic attribution. */
export type SemanticChecker = (turn:ModelTurn, context:DialogueContext, signal:AbortSignal)=>Promise<SemanticResult>;

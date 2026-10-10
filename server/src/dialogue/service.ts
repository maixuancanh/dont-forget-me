import {randomUUID} from "node:crypto";
import type {Store} from "../store.js";
import type {Run,State} from "../model.js";
import type {DialogueContext,TurnRequest,TurnResponse,ModelTurn,SemanticChecker} from "./contracts.js";
import {generateTurn,type DialogueProvider} from "./provider.js";
import {canonicalSerialize,contentHash} from "../domain/serialization.js";

export interface StoredTurn {id:string;clientTurnId:string;requestHash:string;request:TurnRequest;response:TurnResponse;modelTurn:ModelTurn;revision:number;acked:boolean}
interface TurnState extends State {dialogueV2?:Record<string,StoredTurn[]>}
export interface DialogueDependencies {
 provider:DialogueProvider;semanticChecker?:SemanticChecker;
 /** Authoritative context builder validates cursor/trigger/transaction sources.
  * The caller must not derive permissions from client flags.
  */
 context(run:Run,request:TurnRequest):Promise<DialogueContext>;
 assertSession(state:State):void;
 /** Atomic ACK writes displayed utterances/events/outbox and advances checkpoint.
  * No model or remote calls here. Proposed actions stay unaccepted until consent.
  */
 acknowledge(state:State,run:Run,turn:StoredTurn):void;
}
export class DialogueService {
 private readonly inFlight=new Map<string,Promise<TurnResponse>>();
 constructor(private store:Store,private dependencies:DialogueDependencies){}
 private owned(state:State,userId:string,runId:string):Run{
  this.dependencies.assertSession(state);
  const run=state.runs[runId];if(!run||run.userId!==userId)throw new Error("RUN_UNAVAILABLE");return run;
 }
 async request(userId:string,runId:string,request:TurnRequest):Promise<TurnResponse>{
  if(!request.clientTurnId||request.clientTurnId.length>200||request.message.length>1500||request.presentedRecordIds.length>12)throw new Error("INVALID_TURN_REQUEST");
  const requestHash=contentHash(canonicalSerialize(request));
  // Identity covers the payload too. A concurrent forged variant cannot get the
  // response to somebody else's request, even before durable replay checking.
  const key=canonicalSerialize([userId,runId,request.clientTurnId,requestHash]);
  const active=this.inFlight.get(key);if(active)return active;
  const work=this.generate(userId,runId,request,requestHash);
  this.inFlight.set(key,work);
  try{return await work;}finally{if(this.inFlight.get(key)===work)this.inFlight.delete(key);}
 }
 private async generate(userId:string,runId:string,request:TurnRequest,requestHash:string):Promise<TurnResponse>{
  const snapshot=await this.store.transact(state=>{
   const run=this.owned(state,userId,runId);
   const previous=(state as TurnState).dialogueV2?.[runId]?.find(t=>t.clientTurnId===request.clientTurnId);
   if(previous){if(previous.requestHash!==requestHash)throw new Error("TURN_ID_REUSED");return {previous:structuredClone(previous.response)};}
   if(run.revision!==request.expectedRevision)throw new Error("REVISION_CONFLICT");
   if((state as TurnState).dialogueV2?.[runId]?.some(t=>!t.acked))throw new Error("TURN_ACK_REQUIRED");
   return {run:structuredClone(run)};
  });
  if(snapshot.previous)return snapshot.previous;
  const context=await this.dependencies.context(snapshot.run!,request);
  if(context.userId!==userId||context.runId!==runId||context.npcId!==request.npcId||context.packet.beatId!==request.beatId)
    throw new Error("TURN_CONTEXT_MISMATCH");
  const message=request.message.trim() || "Continue the current authorized speaking objective.";
  const generated=await generateTurn(this.dependencies.provider,context,message,{semanticChecker:this.dependencies.semanticChecker});
  return this.store.transact(state=>{
   const run=this.owned(state,userId,runId); // revoked session rejected at commit
   const turns=(((state as TurnState).dialogueV2??={})[runId]??=[]);
   const previous=turns.find(t=>t.clientTurnId===request.clientTurnId);
   if(previous){if(previous.requestHash!==requestHash)throw new Error("TURN_ID_REUSED");return structuredClone(previous.response);}
   if(run.revision!==request.expectedRevision)throw new Error("REVISION_CONFLICT");
   if(turns.some(t=>!t.acked))throw new Error("TURN_ACK_REQUIRED");
   run.revision++;
   const id=randomUUID();
   const response:TurnResponse={turnId:id,runRevision:run.revision,utterance:generated.turn.utterance,generation:"llm",modelId:generated.modelId,memoryState:"saving",recallTraceId:context.recall.traceId,
    citations:generated.turn.sourceIds.map(recordId=>({recordId,label:"Recalled statement"})),
    pendingActions:generated.turn.actions.map(action=>({id:randomUUID(),kind:action.kind,label:action.kind.replaceAll("_"," ")}))};
   turns.push({id,clientTurnId:request.clientTurnId,requestHash,request:structuredClone(request),response,modelTurn:generated.turn,revision:run.revision,acked:false});
   return structuredClone(response);
  });
 }
 async acknowledge(userId:string,runId:string,turnId:string,expectedRevision:number){
  return this.store.transact(state=>{
   const run=this.owned(state,userId,runId),turn=(state as TurnState).dialogueV2?.[runId]?.find(t=>t.id===turnId);
   if(!turn)throw new Error("TURN_UNAVAILABLE");
   if(turn.acked)return {runRevision:run.revision,acknowledged:true};
   if(run.revision!==expectedRevision||turn.revision!==expectedRevision)throw new Error("REVISION_CONFLICT");
   this.dependencies.acknowledge(state,run,turn);
   turn.acked=true;run.revision++;
   return {runRevision:run.revision,acknowledged:true};
  });
 }
}

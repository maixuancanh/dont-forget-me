import {actualOrderItems} from '../gameplay/commerce-actions.js';
import {ObjectService,authorizeObject,objectRecallQuery} from '../story/objects.js';
import {finishRevisit} from '../story/revisit.js';
import {randomUUID} from 'node:crypto';
import type {Store} from '../store.js';
import type {SessionService} from '../auth/session.js';
import type {MemoryRecordV2,NpcId,ActorProjection} from '../domain/contracts.js';
import {canonicalSerialize,contentHash} from '../domain/serialization.js';
import {allowedPacket,priceTable,beats} from '../story/canon.js';
import {PostgresRepository,type AuthoritativeRun} from '../persistence/repository.js';
import {AuthorityError} from '../persistence/transactions.js';
import {AuthoritativeRunService} from '../runs/service.js';
import {VerifiedMemoryReader,type RetrievalBackend,type RetrievalScope} from '../memory/retrieval.js';
import {generateTurn,type DialogueProvider} from './provider.js';
import type {DialogueContext,SemanticChecker,TurnRequest,TurnResponse} from './contracts.js';
import {GameplayService} from '../gameplay/service.js';
import {duyConfidentialityPolicy} from '../gameplay/promise-policy.js';
import {projectPromises} from '../gameplay/promises.js';
import {selectArrivalRecall,acknowledgeArrivalRecall,type RecallAcknowledgement,type RecallCandidate} from '../gameplay/history.js';
import {queryAliasTargets} from '../memory/player-interpretations.js';

export interface RuntimeDialogueOptions {provider?:DialogueProvider;semanticChecker?:SemanticChecker;memoryBackend:RetrievalBackend;binding:(run:AuthoritativeRun)=>Promise<{id:string;namespace:string;network:'local'|'mainnet'}>}
export class PostgresDialogueService {
 private active=new Map<string,Promise<TurnResponse>>();
 readonly runs:AuthoritativeRunService;
 readonly objects:ObjectService;
 constructor(private repository:PostgresRepository,private store:Store,private sessions:SessionService,private options:RuntimeDialogueOptions){this.runs=new AuthoritativeRunService(repository,options.binding);this.objects=new ObjectService(repository);}
 async view(userId:string,runId:string){
  const run=await this.runs.resume(userId,runId);
  const pending=await this.repository.pool.query("SELECT response FROM turns WHERE run_id=$1 AND user_id=$2 AND status='committed' ORDER BY created_at LIMIT 1",[runId,userId]);
  return {...this.runView(run),...(pending.rowCount?{pendingTurn:pending.rows[0].response}: {})};
 }
 runView(run:AuthoritativeRun){
  const beat=run.checkpoint.phase==='complete'?undefined:this.runs.currentBeat(run);
  const items=beat?.orderContract?Object.entries(actualOrderItems(run,beat)).map(([itemId,quantity])=>({itemId,quantity,unitPrice:priceTable.items.find(p=>p.itemId===itemId)!.unitPriceVnd})):[];
  const total=items.reduce((sum,item)=>sum+item.quantity*item.unitPrice,0);
  const paidAmount=priceTable.denominationsVnd.find(n=>n>=total)??total;
  const transactionPreview=items.length?{items,total,paidAmount,acceptedChange:paidAmount-total}:undefined;
  return {run:{...run,day:run.checkpoint.day,cursor:run.checkpoint.scheduleIndex},nextEvent:{sceneId:run.checkpoint.sceneId,stepIndex:run.checkpoint.stepIndex,day:run.checkpoint.day,beatId:run.checkpoint.beatId,kind:beat?.kind??'complete',phase:run.checkpoint.phase,npcId:beat?.npcId,actionIntents:beat?.kind==='player_input'?(beat.inputActions??[]).map(a=>a.intent):beat?.actionIntents??[],inputLabels:beat?.inputLabels??[],transactionPreview}};
 }
 async request(userId:string,sessionId:string,runId:string,request:TurnRequest):Promise<TurnResponse>{
  const key=canonicalSerialize([userId,sessionId,runId,request]);const old=this.active.get(key);if(old)return old;
  const work=this.generate(userId,sessionId,runId,request);this.active.set(key,work);
  try{return await work;}finally{this.active.delete(key);}
 }
 private async generate(userId:string,sessionId:string,runId:string,request:TurnRequest):Promise<TurnResponse>{
  await this.store.transact(s=>this.sessions.assertActive(s,sessionId));
  const run=await this.repository.getRun(userId,runId);
  const previous=await this.repository.getTurn(userId,runId,request.clientTurnId);
  if(previous){const blocked=await this.repository.pool.query("SELECT d.record_id,m.payload->>'linkedTurnId' turn_id FROM memory_tombstones d JOIN memory_records m ON m.id=d.record_id WHERE d.user_id=$1 AND d.run_id=$2",[userId,runId]);if(blocked.rows.some(r=>r.turn_id===previous.id||(previous.response.citations??[]).some((c:any)=>c.recordId===r.record_id)))throw new AuthorityError('TURN_SOURCE_BLOCKED');if(previous.request_hash!==contentHash(canonicalSerialize(request)))throw new AuthorityError('TURN_ID_REUSED');return previous.response;}
  if(run.revision!==request.expectedRevision)throw new AuthorityError('REVISION_CONFLICT');
  if((await this.repository.pool.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[runId])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
  const beat=this.runs.currentBeat(run);
  if(request.beatId!==beat.beatId||request.npcId!==beat.npcId)throw new AuthorityError('BEAT_NOT_AVAILABLE');
  if(run.checkpoint.phase!=='dialogue'||beat.kind==='player_input')throw new AuthorityError('ACTION_NOT_AVAILABLE');
  const triggers:Record<string,string>={greeting:'arrival',payment:'payment',order:'order',ending:'ending',confrontation:'confrontation'};
  const expectedTrigger=triggers[beat.kind]??'arrival';
  if(request.trigger!==expectedTrigger&&request.trigger!=='player_question'&&request.trigger!=='object_shown')throw new AuthorityError('TRIGGER_NOT_AVAILABLE');
  if(request.trigger==='object_shown'&&!request.heldItemInstanceId)throw new AuthorityError('OBJECT_NOT_HELD');
  if(request.heldItemInstanceId&&request.trigger!=='object_shown')throw new AuthorityError('OBJECT_TRIGGER_REQUIRED');
  const shownObject=request.heldItemInstanceId?authorizeObject(run,request.heldItemInstanceId):undefined;
  if(!this.options.provider)throw new AuthorityError('LLM_NOT_CONFIGURED',503);
  const binding=await this.options.binding(run);
  const rows=await this.repository.pool.query(`SELECT m.payload,r.receipt FROM memory_records m JOIN memory_receipts r ON r.record_id=m.id JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id WHERE m.run_id=$1 AND m.user_id=$2 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed')) AND r.account_binding_id=$3 AND r.namespace=$4 ORDER BY m.sequence`,[runId,userId,binding.id,binding.namespace]);
  const gameplay=new GameplayService(this.repository,this.options.binding);
  const allRecords=await gameplay.records(userId,runId);
  const allowedRecordIds=new Set(allRecords.map(r=>r.id));
  const promiseEvents=await gameplay.events(userId,runId);
  const disclosedRecordIds=[...new Set(promiseEvents.flatMap(e=>e.kind==='disclose'&&e.recipient===request.npcId?e.recordIds:[]))].filter(id=>allowedRecordIds.has(id));
  const scope:RetrievalScope={actorVisibleIds:disclosedRecordIds,userId,runId,beatId:beat.beatId,accountBindingId:binding.id,namespace:binding.namespace,network:binding.network,records:rows.rows.filter(r=>allowedRecordIds.has(r.payload.id)&&r.payload.inGameDay<=run.checkpoint.day).map(r=>({record:r.payload,receipt:r.receipt}))};
  // Reject foreign/hidden selected IDs before querying remote memory.
  for(const id of request.presentedRecordIds)if(!scope.records.some(({record:r})=>r.id===id&&(r.actor===request.npcId||r.recipients.includes(request.npcId)||disclosedRecordIds.includes(r.id))))throw new AuthorityError('SOURCE_NOT_AVAILABLE');
  const reader=new VerifiedMemoryReader(async()=>scope,this.options.memoryBackend);
  const aliasTargets=queryAliasTargets(allRecords,userId,runId,request.message).map(id=>allRecords.find(r=>r.id===id)!).filter(r=>r.actor===request.npcId||r.recipients.includes(request.npcId));
  const rawQuery=[request.message||beat.objective,...aliasTargets.map(r=>r.text)].join('\n').slice(0,1500);
  const query=shownObject?objectRecallQuery(shownObject,rawQuery):rawQuery;
  const recall=await reader.read({runId,actor:request.npcId,query,exactRecordIds:request.presentedRecordIds,currentBeatId:beat.beatId});
  if(recall.missingExactRecordIds.length)throw new AuthorityError('EXACT_SOURCE_UNAVAILABLE',503);
  const relationships=projectPromises({userId,runId},allRecords,promiseEvents);
  const actorTrust=relationships.actorTrust[request.npcId];
  const verifiedIds=new Set(recall.sources.map(s=>s.record.id));
  // The model sees only retrieved, actor-visible causal records. Hidden breach
  // state never enters its projection or trust packet.
  const visibleCauses=relationships.causes.filter(c=>actorTrust.causeIds.includes(c.id)&&c.sourceIds.every(id=>verifiedIds.has(id)));
  const commerceCauses=recall.sources.filter(s=>s.record.kind==='relationship'&&s.record.epistemicStatus==='observed'&&(s.record.eventId.startsWith('action:')||s.record.eventId.startsWith('commerce-action:'))&&s.record.id.startsWith('commerce:'));
  const projection:ActorProjection={npcId:request.npcId,knownRecordIds:[...verifiedIds],trustCauseIds:[...visibleCauses.flatMap(c=>c.sourceIds),...commerceCauses.map(s=>s.record.id)],activeCommitmentIds:relationships.commitments.filter(c=>c.status==='accepted'&&(c.proposer===request.npcId||c.beneficiary===request.npcId)&&c.sourceIds.every(id=>verifiedIds.has(id))).map(c=>c.id),unresolvedTopicIds:recall.sources.filter(s=>s.record.kind==='task').flatMap(s=>s.record.entityIds),stance:visibleCauses.some(c=>c.outcome==='breached')?'guarded':'open',stanceCauseIds:visibleCauses.flatMap(c=>c.sourceIds)};
  const candidate=request.trigger==='arrival'?selectArrivalRecall({scope:{userId,runId,storyVersion:run.storyVersion,npcId:request.npcId,sequence:run.eventSequence,inGameDay:run.checkpoint.day},records:recall.sources.map(s=>s.record),projection,commitments:relationships.commitments,acknowledged:(run.state.arrivalRecallAcks??[]) as RecallAcknowledgement[],arrivalComplete:true,deliveryActive:false,horrorActive:false}):undefined;

  const promisePolicy=duyConfidentialityPolicy({scope:{userId,runId},actor:request.npcId,day:run.checkpoint.day,records:allRecords,events:promiseEvents,verifiedRecordIds:[...verifiedIds]});
  // Server state only; unknown trust/promise/object policies stay locked.
  const packet=allowedPacket(beat.beatId,{day:run.checkpoint.day,npcId:beat.npcId,currentBeatId:beat.beatId,witnessedEventIds:allRecords.filter(r=>r.kind==='utterance'&&r.propositionIds.length).flatMap(r=>{const b=beats.find(b=>b.beatId===r.beatId);return b?[b.legacyEventId]:[];}),examinedObjectIds:[],presentedRecordIds:recall.sources.filter(s=>request.presentedRecordIds.includes(s.record.id)).map(s=>s.record.id),trust:visibleCauses.reduce((sum,c)=>sum+c.delta,0)+commerceCauses.length,promise:promisePolicy.promise,caseReviewOpen:run.state.outcome==='resolved',validatedPayment:Boolean(run.state.validatedPayment)});
  if(packet.orderContract)packet.orderContract={...packet.orderContract,items:actualOrderItems(run,beat)};
  const validatedTransaction=beat.kind==='payment'?run.state.validatedPayment as DialogueContext['validatedTransaction']:undefined;
  if(beat.kind==='payment'&&validatedTransaction?.orderId!==`${run.id}:${beat.sceneId}`)throw new AuthorityError('PAYMENT_NOT_VALIDATED');
  const availableTaskRoutes=gameplay.taskScopeAndRoutes(run,recall.sources.map(s=>s.record)).routes.filter(r=>r.npcId===request.npcId).map(({npcId,condition,targetIds})=>({npcId,condition,targetIds:targetIds.slice(0,12)}));
  const taskState=await gameplay.tasks(userId,runId);
  const unavailableTasks=taskState.tasks.filter(t=>t.status!=='withdrawn'&&t.beneficiary===request.npcId&&t.targetIds.every(id=>verifiedIds.has(id))).map(({condition,targetIds,beneficiary})=>({condition,targetIds,beneficiary}));
  const context:DialogueContext={shownObject,disclosedRecordIds,unavailableTasks,availableTaskRoutes,npcId:request.npcId,userId,runId,day:run.checkpoint.day,packet,recall,history:recall.sources.filter(s=>['conversation','utterance'].includes(s.record.kind)).map(s=>s.record),projection,proactiveRecall:candidate,validatedTransaction};
  const generated=await generateTurn(this.options.provider,context,request.message.trim()||'Continue the current authorized speaking objective.',{semanticChecker:this.options.semanticChecker});
  const turnId=randomUUID(),eventId=`turn:${turnId}`;
  const proposals=generated.turn.actions.map(action=>({id:randomUUID(),action}));
  const response:TurnResponse & {request:TurnRequest;proposals:typeof proposals;proactiveRecall?:RecallCandidate}={turnId,runRevision:run.revision+1,utterance:generated.turn.utterance,citations:generated.turn.sourceIds.map(recordId=>({recordId,label:'Recalled statement'})),pendingActions:proposals.map(p=>({id:p.id,kind:p.action.kind,label:p.action.kind.replaceAll('_',' ')})),proposals,...(candidate?{proactiveRecall:candidate}:{}),generation:'llm',modelId:generated.modelId,memoryState:'saving',recallTraceId:recall.traceId,request:structuredClone(request)};
  const base={schemaVersion:2 as const,eventId,userId,runId,sessionId,sequence:run.eventSequence+1,storyVersion:run.storyVersion,beatId:beat.beatId,inGameDay:run.checkpoint.day,createdAt:new Date().toISOString(),epistemicStatus:'said' as const,entityIds:['speaker:'+request.npcId,...generated.turn.expressedPropositionIds.map(id=>'proposition:'+id)],linkedTurnId:turnId};
  const speechId=randomUUID();
  const records:MemoryRecordV2[]=[{...base,id:speechId,actor:request.npcId,kind:'utterance',text:generated.turn.utterance,sourceIds:generated.turn.sourceIds,originIds:[...new Set([...recall.sources.filter(s=>generated.turn.sourceIds.includes(s.record.id)).flatMap(s=>s.record.originIds),...(generated.turn.expressedPropositionIds.length?[speechId]:[])])],recipients:['player',request.npcId],propositionIds:generated.turn.expressedPropositionIds}];
  if(request.message.trim()){const id=randomUUID();records.unshift({...base,id,entityIds:[],actor:'player',kind:'conversation',text:request.message,sourceIds:[],originIds:[id],recipients:['player',request.npcId],propositionIds:[]});}
  // Holding the same auth-store transaction as logout makes the final session
  // check and relational commit ordered against session revocation.
  const committed=await this.store.transact(async state=>{this.sessions.assertActive(state,sessionId);return this.repository.commitTurn({userId,runId,expectedRevision:request.expectedRevision,clientTurnId:request.clientTurnId,eventId,turnId,response,records,bindingId:binding.id,namespace:binding.namespace,request});});
  return committed.response as TurnResponse;
 }
 async acknowledge(userId:string,sessionId:string,runId:string,turnId:string,expectedRevision:number,clientActionId:string){
  const acknowledged=await this.store.transact(async s=>{
   this.sessions.assertActive(s,sessionId);
   const row=(await this.repository.pool.query('SELECT response FROM turns WHERE run_id=$1 AND user_id=$2 AND id=$3',[runId,userId,turnId])).rows[0];
   const recalled=(run:AuthoritativeRun)=>{if(row?.response?.proactiveRecall)run.state.arrivalRecallAcks=acknowledgeArrivalRecall((run.state.arrivalRecallAcks??[]) as RecallAcknowledgement[],row.response.proactiveRecall,turnId);};
   if(['player_question','object_shown'].includes(row?.response?.request?.trigger))return this.repository.acknowledgeTurn({userId,runId,turnId,expectedRevision,clientActionId},run=>{recalled(run);finishRevisit(run);});
   return this.runs.acknowledgeTurn({userId,runId,turnId,expectedRevision,clientActionId},recalled);
  });
  return {...this.runView(acknowledged.run),runRevision:acknowledged.run.revision,acknowledged:true};
 }
}


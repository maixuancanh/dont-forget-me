import {withoutTombstones} from '../memory/tombstones.js';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {reachedProgressionBeats} from '../runs/service.js';
import {NPC_IDS,type Commitment,type MemoryRecordV2,type NpcId} from '../domain/contracts.js';
import {canonicalSerialize,contentHash,serializeMemoryRecord,verifySerializedRecord} from '../domain/serialization.js';
import {PostgresRepository,type AuthoritativeRun} from '../persistence/repository.js';
import {AuthorityError} from '../persistence/transactions.js';
import {projectPromises,promisePreviewHash,type PromiseEvent} from './promises.js';
import {projectTasks,taskPreviewHash,returnSessionRecap,type TaskEvent,type TaskRoute,type TaskScope} from '../story/tasks.js';

export interface GameplayBinding {id:string;namespace:string;network:'local'|'mainnet'}
export interface GameplayReadContext {transactionClient?:PoolClient;lockedRun?:AuthoritativeRun;binding?:GameplayBinding}
export type JournalAction = {kind:'note';text:string;recordIds:string[]}
 | {kind:'alias';text:string;recordIds:string[]}
 | {kind:'correct';text:string;recordId:string}
 | {kind:'share';recipient:NpcId;recordIds:string[]}
 | {kind:'accept_promise';turnId:string;proposalId:string}
 | {kind:'accept_task';turnId:string;proposalId:string}
 | {kind:'withdraw_task';taskId:string};
export class GameplayService {
 constructor(private repo:PostgresRepository,private binding:(run:AuthoritativeRun)=>Promise<GameplayBinding>){}
 private async scopedRun(userId:string,runId:string,context:GameplayReadContext):Promise<AuthoritativeRun>{
  const run=context.lockedRun??(context.transactionClient?await this.repo.lockedRun(context.transactionClient,userId,runId):await this.repo.getRun(userId,runId));
  if(run.id!==runId||run.userId!==userId)throw new AuthorityError('FORBIDDEN',403);
  return run;
 }
 async records(userId:string,runId:string,context:GameplayReadContext={}):Promise<MemoryRecordV2[]>{
  const run=await this.scopedRun(userId,runId,context);
  const rows=await (context.transactionClient??this.repo.pool).query(`SELECT m.id,m.run_id,m.user_id,m.payload,m.payload_bytes,m.content_hash FROM memory_records m JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id AND e.user_id=m.user_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id AND t.user_id=m.user_id WHERE m.run_id=$1 AND m.user_id=$2 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed')) ORDER BY m.sequence,m.id`,[runId,userId]);
  return withoutTombstones(context.transactionClient??this.repo.pool,userId,runId,rows.rows.map(row=>{const r=verifySerializedRecord(row.payload_bytes,row.content_hash);if(r.id!==row.id||r.userId!==userId||r.runId!==runId||row.user_id!==userId||row.run_id!==runId||canonicalSerialize(row.payload)!==row.payload_bytes)throw new AuthorityError('RECORD_SCOPE_OR_HASH_MISMATCH',409);return r;}).filter(r=>r.inGameDay<=run.checkpoint.day));
 }
 async events(userId:string,runId:string,context:GameplayReadContext={}):Promise<PromiseEvent[]>{
  await this.scopedRun(userId,runId,context);
  const rows=await (context.transactionClient??this.repo.pool).query("SELECT payload FROM domain_events WHERE run_id=$1 AND user_id=$2 AND kind='journal_action' ORDER BY sequence",[runId,userId]);
  const visible=new Set((await this.records(userId,runId,context)).map(r=>r.id));
  return rows.rows.filter(r=>!r.payload.result.record||visible.has(r.payload.result.record.id)).flatMap(r=>r.payload.result.promiseEvents??[]).filter(e=>e.sourceIds.every((id:string)=>visible.has(id))&&(e.kind!=='offer'||e.commitment.sourceIds.every((id:string)=>visible.has(id))));
 }
 taskScopeAndRoutes(run:AuthoritativeRun,records:readonly MemoryRecordV2[]):{scope:TaskScope;routes:TaskRoute[]}{
  // Keep previously authored reachable NPC/scenes, so advancing never invalidates accepted history.
  const seen=reachedProgressionBeats(run.checkpoint.scheduleIndex).filter(b=>NPC_IDS.includes(b.npcId as NpcId));
  const scope:TaskScope={userId:run.userId,runId:run.id,day:run.checkpoint.day,seenNpcIds:[...new Set(seen.map(b=>b.npcId as NpcId))],reachableSceneIds:[...new Set(seen.map(b=>b.sceneId))]};
  const targets=records.filter(r=>r.userId===run.userId&&r.runId===run.id&&r.inGameDay<=run.checkpoint.day&&r.recipients.includes('player')).map(r=>r.id);
  const routes:TaskRoute[]=[];
  for(const b of seen){const id=`show_source:${b.npcId}:${b.sceneId}`;if(!routes.some(r=>r.id===id))routes.push({id,npcId:b.npcId as NpcId,sceneId:b.sceneId,condition:'show_source',targetIds:targets,minimumDay:b.day,enabled:true});}
  return{scope,routes};
 }
 async taskEvents(userId:string,runId:string,context:GameplayReadContext={}):Promise<TaskEvent[]>{
  await this.scopedRun(userId,runId,context);
  const rows=await (context.transactionClient??this.repo.pool).query("SELECT payload FROM domain_events WHERE run_id=$1 AND user_id=$2 AND kind='journal_action' ORDER BY sequence",[runId,userId]);
  const visible=new Set((await this.records(userId,runId,context)).map(r=>r.id));
  return rows.rows.filter(r=>!r.payload.result.record||visible.has(r.payload.result.record.id)).flatMap(r=>r.payload.result.taskEvents??[]).filter(e=>e.sourceIds.every((id:string)=>visible.has(id))&&(e.kind!=='offer'||e.task.sourceIds.every((id:string)=>visible.has(id))));
 }
 async tasks(userId:string,runId:string,context:GameplayReadContext={}){
  const run=await this.scopedRun(userId,runId,context),records=await this.records(userId,runId,context),{scope,routes}=this.taskScopeAndRoutes(run,records);
  return projectTasks(scope,records,routes,await this.taskEvents(userId,runId,context));
 }
 async recap(userId:string,runId:string,context:GameplayReadContext={}){
  const run=await this.scopedRun(userId,runId,context),records=await this.records(userId,runId,context),binding=context.binding??await this.binding(run);
  const receiptRows=await (context.transactionClient??this.repo.pool).query("SELECT r.record_id FROM memory_receipts r JOIN memory_records m ON m.id=r.record_id WHERE m.run_id=$1 AND m.user_id=$2 AND r.account_binding_id=$3 AND r.namespace=$4 AND r.state='retrievable' AND r.content_hash=m.content_hash AND r.receipt->>'verifiedAt' IS NOT NULL",[runId,userId,binding.id,binding.namespace]);
  const projection=await this.tasks(userId,runId,context);
  return returnSessionRecap(this.taskScopeAndRoutes(run,records).scope,records,receiptRows.rows.map(r=>r.record_id),projection.tasks);
 }
 async preview(userId:string,runId:string,action:JournalAction,context:GameplayReadContext={}){
  const run=await this.scopedRun(userId,runId,context),records=await this.records(userId,runId,context);
  const ids='recordIds' in action?action.recordIds:'recordId' in action?[action.recordId]:[];
  if(new Set(ids).size!==ids.length||ids.length>12)throw new AuthorityError('INVALID_SOURCE_SELECTION',400);
  const selected=ids.map(id=>{const r=records.find(r=>r.id===id&&r.recipients.includes('player'));if(!r)throw new AuthorityError('SOURCE_NOT_AVAILABLE',403);return r;});
  let commitment:Commitment|undefined;
  if(action.kind==='correct'){
   const original=selected[0];
   if(!original||original.actor!=='player'||!['hypothesis','interpretation','correction'].includes(original.kind))throw new AuthorityError('ORIGINAL_QUOTE_READ_ONLY',403);
   if(records.some(r=>r.supersedesId===original.id))throw new AuthorityError('CORRECTION_STALE');
  }
  if(action.kind==='alias'&&(selected.length!==1||records.some(r=>r.kind==='alias'&&r.text.normalize('NFKC').toLocaleLowerCase()===action.text.normalize('NFKC').toLocaleLowerCase())))throw new AuthorityError('ALIAS_DUPLICATE_OR_TARGET_INVALID');
  if(action.kind==='share'){
   if(!reachedProgressionBeats(run.checkpoint.scheduleIndex).some(beat=>beat.npcId===action.recipient))throw new AuthorityError('RECIPIENT_NOT_AVAILABLE',403);
   if(!selected.length)throw new AuthorityError('SOURCE_NOT_AVAILABLE');
   // A receipt proves the earlier verified write/read, not a new remote download.
   const binding=context.binding??await this.binding(run);
   const receipts=await (context.transactionClient??this.repo.pool).query("SELECT r.record_id,r.content_hash FROM memory_receipts r JOIN memory_records m ON m.id=r.record_id WHERE r.record_id=ANY($1::text[]) AND m.run_id=$2 AND m.user_id=$3 AND r.account_binding_id=$4 AND r.namespace=$5 AND r.state='retrievable' AND r.receipt->>'verifiedAt' IS NOT NULL AND r.content_hash=m.content_hash",[ids,runId,userId,binding.id,binding.namespace]);
   if(new Set(receipts.rows.map(r=>r.record_id)).size!==ids.length)throw new AuthorityError('MEMORY_NOT_CONFIRMED',503);
  }
  if(action.kind==='accept_promise'||action.kind==='accept_task'){
   const row=(await (context.transactionClient??this.repo.pool).query("SELECT response FROM turns WHERE id=$1 AND run_id=$2 AND user_id=$3 AND status='acknowledged'",[action.turnId,runId,userId])).rows[0];
   const offer=row?.response?.proposals?.find((p:any)=>p.id===action.proposalId&&p.action.kind==='offer_commitment');
   if(!offer||offer.action.commitment.type!==(action.kind==='accept_task'?'task':'promise'))throw new AuthorityError(action.kind==='accept_task'?'TASK_OFFER_UNAVAILABLE':'PROMISE_OFFER_UNAVAILABLE');
   const c=offer.action.commitment;
   if(c.sourceIds.some((id:string)=>!records.some(r=>r.id===id))||c.targetIds.some((id:string)=>!records.some(r=>r.id===id||r.entityIds.includes(id))))throw new AuthorityError('PROMISE_SOURCE_UNAVAILABLE');
   commitment={...c,id:`commitment:${action.turnId}:${action.proposalId}`,status:'offered'};
   if(!commitment!.sourceIds.length){const source=records.find(r=>r.linkedTurnId===action.turnId&&r.actor===c.proposer);if(!source)throw new AuthorityError('PROMISE_SOURCE_UNAVAILABLE');commitment!.sourceIds=[source.id];}
  }
  if(action.kind==='accept_task'){
   const {scope,routes}=this.taskScopeAndRoutes(run,records),events=await this.taskEvents(userId,runId,context);
   try{projectTasks(scope,records,routes,[...events,{userId,runId,id:'preview-task-offer',sequence:run.eventSequence+1,sourceIds:commitment!.sourceIds,kind:'offer',task:commitment!}]);}catch(error){throw new AuthorityError(error instanceof Error?error.message:'TASK_INVALID');}
  }
  if(action.kind==='withdraw_task'){const projection=await this.tasks(userId,runId,context);if(!projection.tasks.some(t=>t.id===action.taskId&&t.status==='accepted'))throw new AuthorityError('TASK_NOT_ACTIVE');}
  const quotes=selected.map(r=>({id:r.id,text:r.text,actor:r.actor,epistemicStatus:r.epistemicStatus,hash:contentHash(canonicalSerialize(r))}));
  const promiseState=projectPromises({userId,runId},records,await this.events(userId,runId,context));
  const atRisk=action.kind==='share'?promiseState.commitments.filter(c=>c.status==='accepted'&&c.condition==='keep_confidential'&&c.forbiddenRecipients.includes(action.recipient)&&selected.some(r=>c.targetIds.includes(r.id)||r.entityIds.some(id=>c.targetIds.includes(id)||c.topicEntityIds.includes(id)))).map(c=>c.id):[];
  const preview={action,revision:run.revision,quotes,...(commitment?{commitment}:{}),atRisk,provenance:'canonical_ledger_with_prior_receipt'};
  return {...preview,consentHash:contentHash(canonicalSerialize(preview))};
 }
 async commit(userId:string,sessionId:string,runId:string,input:{expectedRevision:number;clientActionId:string;consentHash:string;action:JournalAction}){
  const initial=await this.repo.getRun(userId,runId),binding=await this.binding(initial);
  const eventId=`journal:${input.clientActionId}`;
  return this.repo.mutateRun({userId,runId,expectedRevision:input.expectedRevision,clientActionId:input.clientActionId,eventId,kind:'journal_action',payload:input},async(c,run,sequence)=>{
   const context:GameplayReadContext={transactionClient:c,lockedRun:run,binding};
   if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[runId])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
   const preview=await this.preview(userId,runId,input.action,context);
   if(preview.revision!==run.revision||preview.consentHash!==input.consentHash)throw new AuthorityError('CONSENT_STALE');
   const ids=preview.quotes.map(r=>r.id),id=randomUUID();
   const action=input.action;
   const base={schemaVersion:2 as const,id,eventId,userId,runId,sessionId,sequence,storyVersion:run.storyVersion,beatId:run.checkpoint.beatId,inGameDay:run.checkpoint.day,createdAt:new Date().toISOString(),actor:'player' as const,sourceIds:ids,originIds:[...new Set((await this.records(userId,runId,context)).filter(r=>ids.includes(r.id)).flatMap(r=>r.originIds))],entityIds:[],propositionIds:[],recipients:['player' as const]};
   let record:MemoryRecordV2;
   const promiseEvents:PromiseEvent[]=[];
   const taskEvents:TaskEvent[]=[];
   const eventBase={id:eventId,userId,runId,sequence,sourceIds:ids};
   if(action.kind==='share'){
    record={...base,kind:'disclosure',epistemicStatus:'observed',recipients:['player',action.recipient],text:JSON.stringify({type:'disclosure',recipient:action.recipient,quotes:preview.quotes.map(({hash,...quote})=>quote)})};
    promiseEvents.push({...eventBase,kind:'disclose',recipient:action.recipient,recordIds:ids});
    const taskRecords=await this.records(userId,runId,context),{scope,routes}=this.taskScopeAndRoutes(run,taskRecords);
    const route=routes.find(r=>r.npcId===action.recipient);
    if(route){const completion:TaskEvent={...eventBase,kind:'complete',routeId:route.id,condition:'show_source',targetIds:ids,npcId:action.recipient};projectTasks(scope,taskRecords,routes,[...await this.taskEvents(userId,runId,context),completion]);taskEvents.push(completion);}
   }else if(action.kind==='accept_promise'){
    const commitment=preview.commitment!;
    const existing=projectPromises({userId,runId},await this.records(userId,runId,context),await this.events(userId,runId,context));
    if(existing.commitments.some(c=>c.id===commitment.id))throw new AuthorityError('PROMISE_ALREADY_ACCEPTED');
    promiseEvents.push({...eventBase,id:eventId+':0-offer',sourceIds:commitment.sourceIds,kind:'offer',commitment});
    promiseEvents.push({...eventBase,id:eventId+':1-accept',sourceIds:commitment.sourceIds,kind:'accept',commitmentId:commitment.id,previewHash:promisePreviewHash(commitment),confirmed:true});
    record={...base,sourceIds:commitment.sourceIds,kind:'promise',epistemicStatus:'observed',recipients:['player',...(commitment.beneficiary==='player'?[]:[commitment.beneficiary])],text:JSON.stringify({type:'commitment',commitment:{...commitment,status:'accepted'}})};
   }else if(action.kind==='accept_task'){
    const task=preview.commitment!;
    taskEvents.push({...eventBase,id:eventId+':0-offer',sourceIds:task.sourceIds,kind:'offer',task},{...eventBase,id:eventId+':1-accept',sourceIds:task.sourceIds,kind:'accept',taskId:task.id,confirmed:true,previewHash:taskPreviewHash(task)});
    const taskRecords=await this.records(userId,runId,context),{scope,routes}=this.taskScopeAndRoutes(run,taskRecords);
    projectTasks(scope,taskRecords,routes,[...await this.taskEvents(userId,runId,context),...taskEvents]);
    record={...base,kind:'task',epistemicStatus:'observed',sourceIds:task.sourceIds,recipients:['player',...(task.beneficiary==='player'?[]:[task.beneficiary])],text:JSON.stringify({type:'commitment',commitment:{...task,status:'accepted'}})};
   }else if(action.kind==='withdraw_task'){
    const task=(await this.tasks(userId,runId,context)).tasks.find(t=>t.id===action.taskId)!;
    taskEvents.push({...eventBase,sourceIds:task.sourceIds,kind:'withdraw',taskId:task.id});
    record={...base,kind:'task',epistemicStatus:'observed',sourceIds:task.sourceIds,text:JSON.stringify({type:'task_withdrawal',taskId:task.id})};
   }else record={...base,kind:action.kind==='alias'?'alias':action.kind==='correct'?'correction':'hypothesis',epistemicStatus:'hypothesized',text:action.text,...(action.kind==='correct'?{supersedesId:action.recordId}:{})};
   if(!record.originIds.length)record.originIds=[record.id];
   return {record,promiseEvents,taskEvents,text:'Saved as an append-only record. Original sources are retained.',atRisk:preview.atRisk};
  },async(c,_run,_sequence,result)=>{
   const {record}=result,serialized=serializeMemoryRecord(record);
   await this.repo.insertRecord(c,record,serialized.bytes,serialized.contentHash,binding.id,binding.namespace);
   for(const source of record.sourceIds)await c.query('INSERT INTO evidence_edges(id,run_id,source_id,target_id,kind,cause_event_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),runId,record.id,source,record.kind==='disclosure'?'disclosed_to':record.supersedesId===source?'supersedes':'derived_from',eventId]);
  });
 }
}



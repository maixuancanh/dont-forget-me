import type {Commitment,MemoryRecordV2,NpcId} from '../domain/contracts.js';
import {canonicalSerialize,contentHash} from '../domain/serialization.js';
export interface TaskScope {userId:string;runId:string;day:number;seenNpcIds:NpcId[];reachableSceneIds:string[]}
/** Server-authored action routes only. Alternate routes use the same logical targets. */
export interface TaskRoute {id:string;sceneId:string;npcId:NpcId;condition:Commitment['condition'];targetIds:string[];minimumDay:number;enabled:boolean}
export type TaskEvent={userId:string;runId:string;id:string;sequence:number;sourceIds:string[]} & (
 | {kind:'offer';task:Commitment}
 | {kind:'accept';taskId:string;confirmed:true;previewHash:string}
 | {kind:'withdraw';taskId:string}
 | {kind:'complete';routeId:string;condition:Commitment['condition'];targetIds:string[];npcId:NpcId}
);
export interface TaskOutcome {taskId:string;eventId:string;sequence:number;sourceIds:string[]}
export function taskPreviewHash(task:Commitment):string{return contentHash(canonicalSerialize(Object.fromEntries(Object.entries(task).filter(([,v])=>v!==undefined))));}
export function reachableTaskRoutes(scope:TaskScope,routes:readonly TaskRoute[]):TaskRoute[]{return routes.filter(r=>r.enabled&&r.minimumDay<=scope.day&&scope.seenNpcIds.includes(r.npcId)&&scope.reachableSceneIds.includes(r.sceneId)).map(r=>structuredClone(r));}
const signature=(task:Commitment)=>canonicalSerialize({condition:task.condition,targetIds:[...task.targetIds].sort(),beneficiary:task.beneficiary});
/** Caller supplies acknowledged canonical records and validated committed server events only. */
export function projectTasks(scope:TaskScope,records:readonly MemoryRecordV2[],routes:readonly TaskRoute[],events:readonly TaskEvent[]){
 const index=new Map(records.filter(r=>r.userId===scope.userId&&r.runId===scope.runId&&r.inGameDay<=scope.day).map(r=>[r.id,r]));const tasks=new Map<string,Commitment>();const outcomes:TaskOutcome[]=[];const seen=new Map<string,string>();const reachable=reachableTaskRoutes(scope,routes);
 const compatible=(task:Commitment)=>reachable.filter(r=>r.condition===task.condition&&r.npcId===task.beneficiary&&task.targetIds.every(id=>r.targetIds.includes(id)));
 for(const e of events.filter(e=>e.userId===scope.userId&&e.runId===scope.runId).slice().sort((a,b)=>a.sequence-b.sequence||((a.kind==='offer'?0:1)-(b.kind==='offer'?0:1))||a.id.localeCompare(b.id))){
  const hash=canonicalSerialize(e);if(seen.has(e.id)){if(seen.get(e.id)!==hash)throw Error('TASK_EVENT_CONFLICT');continue;}seen.set(e.id,hash);
  if(!Number.isSafeInteger(e.sequence)||e.sequence<1||e.sourceIds.some(id=>!index.has(id)||index.get(id)!.sequence>e.sequence))throw Error('TASK_SOURCE_UNAVAILABLE');
  if(e.kind==='offer'){
   const task=e.task;if(task.type!=='task'||task.status!=='offered'||!task.targetIds.length||!task.sourceIds.length||task.sourceIds.some(id=>!index.has(id)||index.get(id)!.sequence>e.sequence)||!compatible(task).length)throw Error('TASK_NOT_REACHABLE');
   if(tasks.has(task.id)||[...tasks.values()].some(t=>signature(t)===signature(task)&&t.status!=='withdrawn'))throw Error('TASK_ALREADY_OFFERED');
   tasks.set(task.id,structuredClone(task));
  }else if(e.kind==='accept'){
   const task=tasks.get(e.taskId);if(!task||task.status!=='offered'||e.confirmed!==true||e.previewHash!==taskPreviewHash(task)||!compatible(task).length)throw Error('TASK_CONSENT_INVALID');task.status='accepted';
  }else if(e.kind==='withdraw'){const task=tasks.get(e.taskId);if(task&&(task.status==='accepted'||task.status==='offered'))task.status='withdrawn';}
  else{
   const route=reachable.find(r=>r.id===e.routeId);if(!route||route.npcId!==e.npcId||route.condition!==e.condition||e.targetIds.some(id=>!route.targetIds.includes(id)))throw Error('TASK_COMPLETION_ROUTE_INVALID');
   for(const task of tasks.values())if(task.status==='accepted'&&task.condition===e.condition&&task.beneficiary===e.npcId&&task.targetIds.every(id=>e.targetIds.includes(id))){task.status='fulfilled';outcomes.push({taskId:task.id,eventId:e.id,sequence:e.sequence,sourceIds:[...new Set([...task.sourceIds,...e.sourceIds])]});}
  }
 }
 return{tasks:[...tasks.values()],outcomes,revisitRoutes:scope.day>=6?reachable:[]};
}
/** Suggested actions become offers only when an authored route can really complete them. */
export function validateSuggestedTask(scope:TaskScope,routes:readonly TaskRoute[],suggestion:{condition:Commitment['condition'];targetIds:string[];npcId:NpcId}):TaskRoute[]{const matches=reachableTaskRoutes(scope,routes).filter(r=>r.condition===suggestion.condition&&r.npcId===suggestion.npcId&&suggestion.targetIds.length>0&&suggestion.targetIds.every(id=>r.targetIds.includes(id)));if(!matches.length)throw Error('SUGGESTED_TASK_UNAVAILABLE');return matches;}
export function investigationGuide(scope:TaskScope,records:readonly MemoryRecordV2[],verifiedIds:readonly string[],requiredCategories:readonly string[],evidence:readonly {recordId:string;categories:string[]}[]){
 const known=records.filter(r=>r.userId===scope.userId&&r.runId===scope.runId&&r.inGameDay<=scope.day&&verifiedIds.includes(r.id)&&r.recipients.includes('phuc'));const ids=new Set(known.map(r=>r.id));const categories=new Set(evidence.filter(e=>ids.has(e.recordId)&&known.some(r=>r.id===e.recordId&&['utterance','observation'].includes(r.kind)&&r.epistemicStatus!=='hypothesized')).flatMap(e=>e.categories));return{sourceIds:[...ids],missingCategories:requiredCategories.filter(c=>!categories.has(c))};
}
export function returnSessionRecap(scope:TaskScope,records:readonly MemoryRecordV2[],verifiedIds:readonly string[],tasks:readonly Commitment[]){const visible=records.filter(r=>r.userId===scope.userId&&r.runId===scope.runId&&r.inGameDay<=scope.day&&r.recipients.includes('player')&&verifiedIds.includes(r.id));return{knownFacts:visible.filter(r=>r.epistemicStatus!=='hypothesized').map(r=>({id:r.id,text:r.text,actor:r.actor,epistemicStatus:r.epistemicStatus})),hypotheses:visible.filter(r=>r.epistemicStatus==='hypothesized').map(r=>({id:r.id,text:r.text,actor:r.actor,epistemicStatus:r.epistemicStatus})),openTaskIds:tasks.filter(t=>t.status==='accepted').map(t=>t.id)};}

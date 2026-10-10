import type { MemoryRecordV2, NpcId } from '../domain/contracts.js';
export interface CommerceScope {userId:string;runId:string}
export interface CommerceLine {itemId:string;quantity:number;unitPrice:number}
export type CommerceEvent=CommerceScope & {id:string;sequence:number;orderId:string;clientActionId:string;sourceIds:string[]} & (
 | {kind:'order';npcId:NpcId;priceTableVersion:string;lines:CommerceLine[]}
 | {kind:'change_order';lines:CommerceLine[];priceTableVersion:string}
 | {kind:'deliver';instances:Array<{instanceId:string;itemId:string;quantity:number}>}
 | {kind:'settle';paidAmount:number;acceptedChange:number}
 | {kind:'reserve';npcId:NpcId;itemId:string;quantity:number;reservationId:string}
 | {kind:'cancel_reservation';reservationId:string}
 | {kind:'fulfill_reservation';reservationId:string;instances:Array<{instanceId:string;itemId:string;quantity:number}>}
);
export interface CommerceCause {id:string;eventId:string;sequence:number;orderId:string;npcId:NpcId;kind:'returned_excess'|'corrected_order'|'reservation_kept';sourceIds:string[];details:Record<string,unknown>}
export interface CommerceOrder {orderId:string;npcId:NpcId;priceTableVersion:string;lines:CommerceLine[];state:'ordered'|'delivered'|'settled';changed:boolean;paidAmount?:number;acceptedChange?:number}
export interface CommerceProjection {orders:CommerceOrder[];reservations:Array<{id:string;orderId:string;npcId:NpcId;itemId:string;quantity:number;status:'reserved'|'cancelled'|'fulfilled'}>;causes:CommerceCause[]}
const natural=(n:number)=>Number.isSafeInteger(n)&&n>=0;
function validateLines(lines:CommerceLine[]) {if(!lines.length||new Set(lines.map(l=>l.itemId)).size!==lines.length||lines.some(l=>!l.itemId||!natural(l.quantity)||!l.quantity||!natural(l.unitPrice)))throw new Error('INVALID_ORDER_LINES');const total=lines.reduce((s,l)=>s+l.quantity*l.unitPrice,0);if(!natural(total))throw new Error('INVALID_ORDER_TOTAL');}
/** Only replay committed server events. Client ownership/token/scene validation happens before append. */
export function projectCommerce(scope:CommerceScope,input:readonly CommerceEvent[]):CommerceProjection {
 const orders=new Map<string,CommerceOrder>();const reservations=new Map<string,CommerceProjection['reservations'][number]>();const causes:CommerceCause[]=[];const seen=new Map<string,string>();const actions=new Map<string,string>();const consumed=new Set<string>();
 const cause=(e:CommerceEvent,npcId:NpcId,kind:CommerceCause['kind'],details:Record<string,unknown>)=>{if(causes.some(c=>c.orderId===e.orderId&&c.kind===kind))return;causes.push({id:`commerce:${e.orderId}:${kind}`,eventId:e.id,sequence:e.sequence,orderId:e.orderId,npcId,kind,sourceIds:[...e.sourceIds],details});};
 const consume=(instances:Array<{instanceId:string;itemId:string;quantity:number}>,lines:Array<{itemId:string;quantity:number}>)=>{if(!instances.length||new Set(instances.map(i=>i.instanceId)).size!==instances.length||instances.some(i=>!i.instanceId||consumed.has(i.instanceId)||!natural(i.quantity)||!i.quantity))throw new Error('INVALID_ITEM_INSTANCE');const amounts=new Map<string,number>();for(const i of instances)amounts.set(i.itemId,(amounts.get(i.itemId)??0)+i.quantity);if(amounts.size!==lines.length||lines.some(l=>amounts.get(l.itemId)!==l.quantity))throw new Error('DELIVERY_MISMATCH');for(const i of instances)consumed.add(i.instanceId);};
 for(const e of input.filter(e=>e.userId===scope.userId&&e.runId===scope.runId).slice().sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id))) {
  const fingerprint=JSON.stringify(e);if(seen.has(e.id)){if(seen.get(e.id)!==fingerprint)throw new Error('COMMERCE_EVENT_CONFLICT');continue;}seen.set(e.id,fingerprint);
  if(!e.id||!e.orderId||!e.clientActionId||!natural(e.sequence)||!e.sequence)throw new Error('INVALID_COMMERCE_EVENT');if(actions.has(e.clientActionId))throw new Error('COMMERCE_ACTION_CONFLICT');actions.set(e.clientActionId,e.id);
  if(e.kind==='order'){validateLines(e.lines);if(orders.has(e.orderId)||!e.priceTableVersion)throw new Error('ORDER_ALREADY_EXISTS');orders.set(e.orderId,{orderId:e.orderId,npcId:e.npcId,priceTableVersion:e.priceTableVersion,lines:structuredClone(e.lines),state:'ordered',changed:false});continue;}
  if(e.kind==='reserve'){if(!e.reservationId||reservations.has(e.reservationId)||!e.itemId||!natural(e.quantity)||!e.quantity)throw new Error('INVALID_RESERVATION');reservations.set(e.reservationId,{id:e.reservationId,orderId:e.orderId,npcId:e.npcId,itemId:e.itemId,quantity:e.quantity,status:'reserved'});continue;}
  if(e.kind==='cancel_reservation'||e.kind==='fulfill_reservation'){const r=reservations.get(e.reservationId);if(!r||r.orderId!==e.orderId||r.status!=='reserved')throw new Error('RESERVATION_NOT_ACTIVE');if(e.kind==='cancel_reservation')r.status='cancelled';else{consume(e.instances,[r]);r.status='fulfilled';cause(e,r.npcId,'reservation_kept',{reservationId:r.id,itemId:r.itemId,quantity:r.quantity});}continue;}
  const o=orders.get(e.orderId);if(!o)throw new Error('ORDER_NOT_FOUND');
  if(e.kind==='change_order'){if(o.state!=='ordered')throw new Error('ORDER_CHANGE_TOO_LATE');validateLines(e.lines);if(!e.priceTableVersion)throw new Error('PRICE_VERSION_REQUIRED');if(JSON.stringify(o.lines)!==JSON.stringify(e.lines)){o.changed=true;o.lines=structuredClone(e.lines);o.priceTableVersion=e.priceTableVersion;}}
  if(e.kind==='deliver'){if(o.state!=='ordered')throw new Error('ORDER_ALREADY_DELIVERED');consume(e.instances,o.lines);o.state='delivered';if(o.changed)cause(e,o.npcId,'corrected_order',{lines:o.lines});}
  if(e.kind==='settle'){if(o.state!=='delivered')throw new Error('ORDER_NOT_DELIVERED');const total=o.lines.reduce((sum,l)=>sum+l.unitPrice*l.quantity,0);if(!natural(e.paidAmount)||!natural(e.acceptedChange)||e.paidAmount<total||e.acceptedChange!==e.paidAmount-total)throw new Error('PAYMENT_MISMATCH');o.state='settled';o.paidAmount=e.paidAmount;o.acceptedChange=e.acceptedChange;if(e.acceptedChange>0)cause(e,o.npcId,'returned_excess',{total,paidAmount:e.paidAmount,acceptedChange:e.acceptedChange,priceTableVersion:o.priceTableVersion});}
 }
 return {orders:[...orders.values()],reservations:[...reservations.values()],causes};
}
/** Materialize only meaningful outcomes; root commits these in the action's transaction/outbox. */
export function buildCommerceRecords(scope:CommerceScope,causes:readonly CommerceCause[],context:{sessionId:string;storyVersion:string;beatId:string;inGameDay:number;createdAt:string}):MemoryRecordV2[]{return causes.map(c=>({schemaVersion:2,id:c.id,eventId:c.eventId,...scope,...context,sequence:c.sequence,actor:'player',kind:'relationship',text:JSON.stringify({type:'commerce_outcome',outcome:c.kind,orderId:c.orderId,npcId:c.npcId,...c.details}),epistemicStatus:'observed',sourceIds:[...c.sourceIds],originIds:[c.eventId],recipients:['player',c.npcId],entityIds:[c.orderId],propositionIds:[]}));}


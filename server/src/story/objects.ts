import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PostgresRepository,type AuthoritativeRun} from '../persistence/repository.js';
import {AuthorityError} from '../persistence/transactions.js';
import {AuthoritativeRunService} from '../runs/service.js';
interface CatalogItem {itemId:string;displayName:string;semanticEntities:string[];sourceLut:string}
export interface SceneStockSlot {slotId:string;nodePath:string;itemId:string;quantity:number;template:string;origin:'scene_dispenser'|'static_scene_object'}
export const sceneStock=JSON.parse(readFileSync(new URL('../../story/scene-stock.json',import.meta.url),'utf8')) as {storyScenes:string[];slots:SceneStockSlot[]};
export const objectCatalog=(JSON.parse(readFileSync(new URL('../../story/object-associations.json',import.meta.url),'utf8')) as {items:CatalogItem[]}).items;
export interface PhysicalObject {instanceId:string;itemId:string;userId:string;runId:string;sceneId:string;quantity:number;clientSlot:string;status:'available'|'consumed'|'reserved'}
interface Inventory {instances:PhysicalObject[];heldInstanceId:string|null}
export interface AuthorizedObject {instanceId:string;itemId:string;displayName:string;semanticEntities:string[];associationKnown:boolean;meaning:'shown_only_not_delivered_or_paid'}
export function physicalInventory(run:AuthoritativeRun):Inventory {return (run.state.physicalObjects??{instances:[],heldInstanceId:null}) as Inventory;}
export function bindPhysicalObject(run:AuthoritativeRun,itemId:string,idFactory:()=>string=()=>randomUUID(),clientSlot='',quantity=1):PhysicalObject {
 if(!objectCatalog.some(i=>i.itemId===itemId))throw new AuthorityError('OBJECT_ITEM_NOT_AVAILABLE');
 if(!Number.isSafeInteger(quantity)||quantity<1||quantity>99)throw new AuthorityError('OBJECT_QUANTITY_INVALID');
 if(!sceneStock.storyScenes.includes(run.checkpoint.sceneId))throw new AuthorityError('OBJECT_SCENE_NOT_AVAILABLE');
 const slot=sceneStock.slots.find(slot=>slot.slotId===clientSlot);
 if(!slot||slot.itemId!==itemId)throw new AuthorityError('OBJECT_SLOT_NOT_AVAILABLE');
 if(quantity!==slot.quantity)throw new AuthorityError('OBJECT_STOCK_QUANTITY_MISMATCH');
 const inventory=physicalInventory(run);
 const old=inventory.instances.find(i=>i.clientSlot===clientSlot&&i.sceneId===run.checkpoint.sceneId);
 if(old){if(old.status!=='available')throw new AuthorityError('OBJECT_STOCK_EXHAUSTED');if(old.itemId!==slot.itemId||old.quantity!==slot.quantity||old.userId!==run.userId||old.runId!==run.id)throw new AuthorityError('OBJECT_SLOT_CONFLICT');return old;}
 const item:PhysicalObject={instanceId:idFactory(),itemId,userId:run.userId,runId:run.id,sceneId:run.checkpoint.sceneId,quantity,clientSlot,status:'available'};
 inventory.instances.push(item);run.state.physicalObjects=inventory;return item;
}
export function holdPhysicalObject(run:AuthoritativeRun,instanceId:string|null){const inventory=physicalInventory(run);if(instanceId){const i=inventory.instances.find(i=>i.instanceId===instanceId&&i.status==='available'&&i.userId===run.userId&&i.runId===run.id);if(!i)throw new AuthorityError('OBJECT_NOT_AVAILABLE');if(i.sceneId!==run.checkpoint.sceneId)throw new AuthorityError('OBJECT_SCENE_MISMATCH');}inventory.heldInstanceId=instanceId;run.state.physicalObjects=inventory;}
export function authorizeObject(run:AuthoritativeRun,instanceId:string):AuthorizedObject {
 const inventory=physicalInventory(run),item=inventory.instances.find(i=>i.instanceId===instanceId&&i.userId===run.userId&&i.runId===run.id&&i.status==='available');
 if(!item)throw new AuthorityError('OBJECT_NOT_AVAILABLE');
 if(item.sceneId!==run.checkpoint.sceneId)throw new AuthorityError('OBJECT_SCENE_MISMATCH');
 if(inventory.heldInstanceId!==instanceId)throw new AuthorityError('OBJECT_NOT_HELD');
 const association=objectCatalog.find(i=>i.itemId===item.itemId);if(!association)throw new AuthorityError('OBJECT_ITEM_NOT_AVAILABLE');
 return {instanceId,itemId:item.itemId,displayName:association.displayName,semanticEntities:[...association.semanticEntities],associationKnown:association.semanticEntities.length>0,meaning:'shown_only_not_delivered_or_paid'};
}
// These are search hints, not authorized story propositions or evidence.
export function objectRecallQuery(object:AuthorizedObject,message:string){return [message,object.displayName,...object.semanticEntities].join('\n').slice(0,1500);}
export class ObjectService {
 constructor(private repository:PostgresRepository){}
 async inventory(userId:string,runId:string){const run=await this.repository.getRun(userId,runId);return {runRevision:run.revision,...physicalInventory(run),catalog:objectCatalog.map(({itemId,displayName})=>({itemId,displayName})),slots:sceneStock.storyScenes.includes(run.checkpoint.sceneId)?sceneStock.slots:[]};}
 async bind(input:{userId:string;runId:string;expectedRevision:number;clientActionId:string;itemId:string;clientSlot?:string;quantity?:number}){return this.mutate(input,'bind',{itemId:input.itemId,clientSlot:input.clientSlot??'',quantity:input.quantity??1},run=>{const item=bindPhysicalObject(run,input.itemId,()=>randomUUID(),input.clientSlot,input.quantity);holdPhysicalObject(run,item.instanceId);return {item,heldInstanceId:item.instanceId};});}
 async hold(input:{userId:string;runId:string;expectedRevision:number;clientActionId:string;instanceId:string|null}){return this.mutate(input,'hold',{instanceId:input.instanceId},run=>{holdPhysicalObject(run,input.instanceId);return {heldInstanceId:input.instanceId};});}
 private mutate<T>(input:{userId:string;runId:string;expectedRevision:number;clientActionId:string},kind:string,payload:unknown,apply:(run:AuthoritativeRun)=>T){return this.repository.mutateRun({...input,eventId:`object:${input.clientActionId}`,kind:`object_${kind}`,payload},async(c,run)=>{new AuthoritativeRunService(this.repository).currentBeat(run);if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');return apply(run);});}
}

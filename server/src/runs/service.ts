import {actualOrderItems,validateChangedOrder,reservations,reservePhysicalItem,cancelPhysicalReservation,fulfillPhysicalReservation,type CommerceAction} from '../gameplay/commerce-actions.js';
import {authorizedRevisitBeat,finishRevisit} from '../story/revisit.js';
import {NPC_IDS,type NpcId} from '../domain/contracts.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {beats,priceTable,STORY_VERSION,type Beat} from '../story/canon.js';
import {PostgresRepository,type AuthoritativeRun,type Checkpoint} from '../persistence/repository.js';
import {AuthorityError,transaction} from '../persistence/transactions.js';
import {buildCommerceRecords,type CommerceCause} from '../gameplay/commerce.js';
import {serializeMemoryRecord} from '../domain/serialization.js';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
// Supplemental reveals require a separate authorized trigger; they are never implicit day advancement.
export const progressionBeats=beats.filter(b=>b.legacyType!=='supplemental'&&!b.revealConditions.serverPrivate);
// Keep persisted indices stable. Payment beats were appended after speech in the
// authored array; traversal must follow the physical scene's step order instead.
const sceneOrder=new Map<string,number>();
for(const beat of progressionBeats)if(!sceneOrder.has(beat.sceneId))sceneOrder.set(beat.sceneId,sceneOrder.size);
const choreography=progressionBeats.map((beat,index)=>({beat,index})).sort((a,b)=>sceneOrder.get(a.beat.sceneId)!-sceneOrder.get(b.beat.sceneId)!||a.beat.stepIndex-b.beat.stepIndex);
export function nextProgressionIndex(index:number,acknowledged:ReadonlySet<string>=new Set()):number {
 const position=choreography.findIndex(item=>item.index===index);
 if(position<0)throw new AuthorityError('CHECKPOINT_INVALID');
 return choreography.slice(position+1).find(item=>!acknowledged.has(item.beat.beatId))?.index??progressionBeats.length;
}
export function reachedProgressionBeats(index:number):Beat[]{
 if(index===progressionBeats.length)return choreography.map(item=>item.beat);
 const position=choreography.findIndex(item=>item.index===index);
 if(position<0)throw new AuthorityError('CHECKPOINT_INVALID');
 return choreography.slice(0,position+1).map(item=>item.beat);
}
function checkpoint(index:number):Checkpoint {
  const beat=progressionBeats[index];if(!beat)return {beatId:'complete',day:6,sceneId:'complete',stepIndex:0,scheduleIndex:index,phase:'complete'};
  return {beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:beat.kind==='payment'?'order':'dialogue'};
}
export interface ServerToken {token:string;kind:'checkpoint'|'order'|'payment';revision:number;preview:unknown;}
export class AuthoritativeRunService {
  constructor(public readonly repository:PostgresRepository,private commerceBinding?:(run:AuthoritativeRun)=>Promise<{id:string;namespace:string}>) {}
  create(userId:string) {return this.repository.createRun({userId,storyVersion:STORY_VERSION,initialCheckpoint:checkpoint(0)});}
  resume(userId:string,runId:string) {return this.repository.getRun(userId,runId);}
  currentBeat(run:AuthoritativeRun):Beat {
    if(run.storyVersion!==STORY_VERSION||run.status!=='active')throw new AuthorityError('RUN_REQUIRES_RECONCILIATION');
    const revisited=authorizedRevisitBeat(run);if(revisited)return revisited;
    const beat=progressionBeats[run.checkpoint.scheduleIndex];
    if(!beat||beat.beatId!==run.checkpoint.beatId||beat.day!==run.checkpoint.day||beat.sceneId!==run.checkpoint.sceneId)throw new AuthorityError('CHECKPOINT_INVALID');return beat;
  }
  async acknowledgeTurn(input:{userId:string;runId:string;expectedRevision:number;turnId:string;clientActionId:string},onAcknowledged?:(run:AuthoritativeRun)=>void) {
    return this.repository.acknowledgeTurn(input,async(run,c)=>{
      const beat=this.currentBeat(run);if(run.checkpoint.phase!=='dialogue')throw new AuthorityError('ACTION_NOT_AVAILABLE');
      onAcknowledged?.(run);if(finishRevisit(run))return;
      const prior=await c.query("SELECT response->'request'->>'beatId' AS beat_id FROM turns WHERE run_id=$1 AND user_id=$2 AND status='acknowledged'",[run.id,run.userId]);
      const acknowledged=new Set<string>(prior.rows.map(r=>r.beat_id).filter(Boolean));acknowledged.add(beat.beatId);
      const earlierPayment=progressionBeats.findIndex(b=>b.sceneId===beat.sceneId&&b.kind==='payment'&&b.stepIndex<beat.stepIndex);
      // Older cases may have displayed a farewell before their payment gate.
      // Revisit the gate; never manufacture a transaction from client visuals.
      if(earlierPayment>=0){
        const ledger=await c.query("SELECT state FROM transactions WHERE run_id=$1 AND user_id=$2 AND order_id=$3",[run.id,run.userId,`${run.id}:${beat.sceneId}`]);
        if(!ledger.rowCount||ledger.rows.some(r=>r.state!=='settled')){run.checkpoint=checkpoint(earlierPayment);return;}
      }
      run.checkpoint=checkpoint(nextProgressionIndex(run.checkpoint.scheduleIndex,acknowledged));
    });
  }
  async issueToken(input:{userId:string;runId:string;expectedRevision:number;kind:ServerToken['kind']}):Promise<ServerToken> {
    return transaction(this.repository.pool,async c=>{
      const run=await this.repository.lockedRun(c,input.userId,input.runId);if(run.revision!==input.expectedRevision)throw new AuthorityError('REVISION_CONFLICT');
      if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
      const beat=this.currentBeat(run);let payload:Record<string,unknown>={beatId:beat.beatId};
      if(input.kind==='checkpoint') {
        // Only player-input beats may advance through checkpoint actions; generated speech requires ACK.
        if(beat.kind!=='player_input'||run.checkpoint.phase!=='dialogue')throw new AuthorityError('ACTION_NOT_AVAILABLE');
        payload={...payload,nextIndex:nextProgressionIndex(run.checkpoint.scheduleIndex),allowedIntents:beat.actionIntents};
      } else if(input.kind==='order') {
        if(run.checkpoint.phase!=='order'||!beat.orderContract)throw new AuthorityError('ACTION_NOT_AVAILABLE');
        const orderId=`${run.id}:${beat.sceneId}`;
        const items=Object.entries(actualOrderItems(run,beat)).map(([itemId,quantity])=>{
          const price=priceTable.items.find(p=>p.itemId===itemId);if(!price)throw new AuthorityError('PRICE_UNAVAILABLE');return {itemId,quantity,unitPrice:price.unitPriceVnd};
        });
        payload={...payload,orderId,items,priceTableVersion:priceTable.version,total:items.reduce((sum,i)=>sum+i.quantity*i.unitPrice,0)};
      } else {
        if(run.checkpoint.phase!=='payment')throw new AuthorityError('ACTION_NOT_AVAILABLE');
        const ledger=await c.query('SELECT * FROM transactions WHERE run_id=$1 AND order_id=$2',[run.id,`${run.id}:${beat.sceneId}`]);
        if(!ledger.rowCount||ledger.rows.some(r=>r.state!=='delivered'))throw new AuthorityError('ORDER_NOT_DELIVERED');
        const total=ledger.rows.reduce((sum,r)=>sum+r.quantity*r.unit_price,0);
        // Server-issued tender quote; physical collection is still client-side, not anti-cheat proof.
        const tender=priceTable.denominationsVnd.find(n=>n>=total)??total;
        payload={...payload,orderId:ledger.rows[0].order_id,total,paidAmount:tender,acceptedChange:tender-total};
      }
      const token=randomBytes(32).toString('base64url');
      await c.query("INSERT INTO action_tokens(token_hash,user_id,run_id,revision,kind,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",[digest(token),run.userId,run.id,run.revision,input.kind,payload]);
      return {token,kind:input.kind,revision:run.revision,preview:payload};
    });
  }
  async acceptTokenAction(input:{userId:string;runId:string;expectedRevision:number;token:string;clientActionId:string;intent?:string}) {
    const binding=this.commerceBinding?await this.commerceBinding(await this.repository.getRun(input.userId,input.runId)):undefined;
    return this.repository.mutateRun({userId:input.userId,runId:input.runId,expectedRevision:input.expectedRevision,eventId:`action:${input.clientActionId}`,clientActionId:input.clientActionId,kind:'token_action',payload:{tokenHash:digest(input.token),intent:input.intent??null}},async(c,run,sequence)=>{
      if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
      const row=await c.query('SELECT * FROM action_tokens WHERE token_hash=$1 AND run_id=$2 AND user_id=$3 FOR UPDATE',[digest(input.token),run.id,run.userId]);
      const token=row.rows[0];if(!token||token.consumed_event_id||new Date(token.expires_at).getTime()<=Date.now()||token.revision!==run.revision)throw new AuthorityError('TOKEN_INVALID');
      const beat=this.currentBeat(run);if(token.payload.beatId!==beat.beatId)throw new AuthorityError('TOKEN_INVALID');
      const before={...run.checkpoint};
      const commerceCauses:CommerceCause[]=[];
      if(token.kind==='checkpoint') {
        if(run.checkpoint.phase!=='dialogue'||beat.kind!=='player_input'||!token.payload.allowedIntents.includes(input.intent))throw new AuthorityError('ACTION_NOT_AVAILABLE');
        if(token.payload.nextIndex!==nextProgressionIndex(run.checkpoint.scheduleIndex))throw new AuthorityError('TOKEN_INVALID');
        run.checkpoint=checkpoint(token.payload.nextIndex);
      } else if(token.kind==='order') {
        if(run.checkpoint.phase!=='order')throw new AuthorityError('ACTION_NOT_AVAILABLE');
        for(const item of token.payload.items)await c.query("INSERT INTO transactions(id,user_id,run_id,order_id,item_id,quantity,price_table_version,unit_price,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'delivered',$9)",[randomUUID(),run.userId,run.id,token.payload.orderId,item.itemId,item.quantity,token.payload.priceTableVersion,item.unitPrice,{clientActionId:input.clientActionId}]);
        if((run.state.changedOrders as Record<string,unknown>|undefined)?.[beat.sceneId])commerceCauses.push({id:`commerce:${token.payload.orderId}:corrected_order`,eventId:`action:${input.clientActionId}`,sequence,orderId:token.payload.orderId,npcId:beat.npcId as NpcId,kind:'corrected_order',sourceIds:[],details:{lines:token.payload.items,priceTableVersion:priceTable.version}});
        run.checkpoint.phase='payment';
      } else if(token.kind==='payment') {
        if(run.checkpoint.phase!=='payment')throw new AuthorityError('ACTION_NOT_AVAILABLE');
        const ledger=await c.query("SELECT * FROM transactions WHERE run_id=$1 AND order_id=$2 AND state='delivered' FOR UPDATE",[run.id,token.payload.orderId]);
        if(!ledger.rowCount)throw new AuthorityError('ORDER_NOT_DELIVERED');
        const rows=ledger.rows;
        const expected=beat.orderContract?actualOrderItems(run,beat):undefined;
        if(token.payload.orderId!==`${run.id}:${beat.sceneId}`||!expected||rows.length!==Object.keys(expected).length||new Set(rows.map(r=>r.item_id)).size!==rows.length||rows.some(r=>r.user_id!==run.userId||r.price_table_version!==priceTable.version||!Number.isSafeInteger(r.quantity)||r.quantity<=0||expected[r.item_id]!==r.quantity||priceTable.items.find(p=>p.itemId===r.item_id)?.unitPriceVnd!==r.unit_price))throw new AuthorityError('ORDER_LEDGER_MISMATCH');
        if(!NPC_IDS.includes(beat.npcId as NpcId))throw new AuthorityError('INVALID_COMMERCE_ACTOR');
        const total=rows.reduce((sum,r)=>sum+r.quantity*r.unit_price,0);
        if(!Number.isSafeInteger(total)||!Number.isSafeInteger(token.payload.paidAmount)||!Number.isSafeInteger(token.payload.acceptedChange)||token.payload.total!==total||token.payload.paidAmount<total||token.payload.acceptedChange!==token.payload.paidAmount-total)throw new AuthorityError('PAYMENT_MISMATCH');
        if(token.payload.acceptedChange>0)commerceCauses.push({id:`commerce:${token.payload.orderId}:returned_excess`,eventId:`action:${input.clientActionId}`,sequence,orderId:token.payload.orderId,npcId:beat.npcId as NpcId,kind:'returned_excess',sourceIds:[],details:{total,paidAmount:token.payload.paidAmount,acceptedChange:token.payload.acceptedChange,priceTableVersion:priceTable.version,lines:rows.map(r=>({transactionId:r.id,itemId:r.item_id,quantity:r.quantity,unitPrice:r.unit_price}))}});
        // Amounts recorded once on the first line; per-line totals remain canonical.
        for(const [index,item] of ledger.rows.entries())await c.query("UPDATE transactions SET state='settled',paid_amount=$2,accepted_change=$3,payload=payload||$4::jsonb WHERE id=$1",[item.id,index===0?token.payload.paidAmount:0,index===0?token.payload.acceptedChange:0,JSON.stringify({paymentActionId:input.clientActionId})]);
        run.state.validatedPayment={orderId:token.payload.orderId,total:token.payload.total,paidAmount:token.payload.paidAmount,acceptedChange:token.payload.acceptedChange};
        run.checkpoint.phase='dialogue';
      } else throw new AuthorityError('TOKEN_INVALID');
      await c.query('UPDATE action_tokens SET consumed_event_id=$2 WHERE token_hash=$1',[token.token_hash,`action:${input.clientActionId}`]);
      return {kind:token.kind,before,after:run.checkpoint,transaction:token.kind==='payment'?run.state.validatedPayment:null,commerceRecords:buildCommerceRecords({userId:run.userId,runId:run.id},commerceCauses,{sessionId:'server-commerce',storyVersion:run.storyVersion,beatId:before.beatId,inGameDay:before.day,createdAt:new Date().toISOString()})};
    },async(c,_run,_sequence,result)=>{
      for(const record of result.commerceRecords){const serialized=serializeMemoryRecord(record);await this.repository.insertRecord(c,record,serialized.bytes,serialized.contentHash,binding?.id,binding?.namespace);}
    });
  }
  async commerceView(userId:string,runId:string){const run=await this.repository.getRun(userId,runId);const beat=this.currentBeat(run);return {runRevision:run.revision,npcId:beat.npcId,phase:run.checkpoint.phase,orderItems:actualOrderItems(run,beat),catalog:priceTable.items,reservations:reservations(run).filter(r=>r.npcId===beat.npcId)};}
  async commerceAction(input:{userId:string;runId:string;expectedRevision:number;clientActionId:string;action:CommerceAction}){
    const binding=this.commerceBinding?await this.commerceBinding(await this.repository.getRun(input.userId,input.runId)):undefined;
    return this.repository.mutateRun({...input,eventId:`commerce-action:${input.clientActionId}`,kind:'commerce_action',payload:input.action},async(c,run,sequence)=>{
      if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
      const beat=this.currentBeat(run);if(!NPC_IDS.includes(beat.npcId as NpcId))throw new AuthorityError('INVALID_COMMERCE_ACTOR');
      const npcId=beat.npcId as NpcId,causes:CommerceCause[]=[],eventId=`commerce-action:${input.clientActionId}`;
      let result:unknown;
      if(input.action.kind==='change_order'){
        if(run.checkpoint.phase!=='order'||!beat.orderContract)throw new AuthorityError('ORDER_CHANGE_TOO_LATE');
        const lines=validateChangedOrder(input.action.lines);const orders=(run.state.changedOrders??{}) as Record<string,Record<string,number>>;
        const changed=Object.fromEntries(lines.map(l=>[l.itemId,l.quantity]));
        if(Object.keys(changed).length===Object.keys(beat.orderContract.items).length&&Object.entries(changed).every(([id,q])=>beat.orderContract!.items[id]===q))delete orders[beat.sceneId];else orders[beat.sceneId]=changed;run.state.changedOrders=orders;
        // Outstanding quotes issued before the explicit edit may never deliver the old order.
        await c.query("UPDATE action_tokens SET expires_at=now() WHERE run_id=$1 AND kind='order' AND consumed_event_id IS NULL",[run.id]);result={lines};
      }else if(input.action.kind==='reserve')result=reservePhysicalItem(run,npcId,input.action.instanceId,eventId);
      else if(input.action.kind==='cancel_reservation')result=cancelPhysicalReservation(run,npcId,input.action.reservationId);
      else {
        const r=fulfillPhysicalReservation(run,npcId,input.action.reservationId);result=r;
        causes.push({id:`commerce:${r.id}:reservation_kept`,eventId,sequence,orderId:r.id,npcId,kind:'reservation_kept',sourceIds:[],details:{reservationId:r.id,itemId:r.itemId,quantity:r.quantity,instanceId:r.instanceId,reservedScene:r.sceneId,fulfilledScene:run.checkpoint.sceneId}});
      }
      return {kind:input.action.kind,result,commerceRecords:buildCommerceRecords({userId:run.userId,runId:run.id},causes,{sessionId:'server-commerce',storyVersion:run.storyVersion,beatId:beat.beatId,inGameDay:run.checkpoint.day,createdAt:new Date().toISOString()})};
    },async(c,_run,_sequence,result)=>{for(const record of result.commerceRecords){const serialized=serializeMemoryRecord(record);await this.repository.insertRecord(c,record,serialized.bytes,serialized.contentHash,binding?.id,binding?.namespace);}});
  }

}

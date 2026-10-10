import {it,expect,vi} from 'vitest';
import {AuthoritativeRunService,progressionBeats} from '../src/runs/service.js';
import {priceTable,STORY_VERSION} from '../src/story/canon.js';
import type {PostgresRepository,AuthoritativeRun} from '../src/persistence/repository.js';
const index=progressionBeats.findIndex(b=>b.kind==='payment'&&b.orderContract);
const beat=progressionBeats[index];
function setup(options:{badChange?:boolean;badQuantity?:boolean;exact?:boolean;binding?:boolean}={}){
 const run:AuthoritativeRun={id:'r',userId:'u',storyVersion:STORY_VERSION,revision:0,eventSequence:0,checkpoint:{beatId:beat.beatId,day:beat.day,sceneId:beat.sceneId,stepIndex:beat.stepIndex,scheduleIndex:index,phase:'payment'},state:{},status:'active'};
 const rows=Object.entries(beat.orderContract!.items).map(([itemId,quantity])=>({id:`tx:${itemId}`,user_id:'u',run_id:'r',order_id:`r:${beat.sceneId}`,item_id:itemId,quantity,unit_price:priceTable.items.find(p=>p.itemId===itemId)!.unitPriceVnd,price_table_version:priceTable.version,state:'delivered'}));
 const total=rows.reduce((s,r)=>s+r.quantity*r.unit_price,0);const paid=total+(options.exact?0:1000);
 if(options.badQuantity)rows[0].quantity++;
 const token={kind:'payment',revision:0,expires_at:new Date(Date.now()+60000).toISOString(),token_hash:'hash',payload:{beatId:beat.beatId,orderId:`r:${beat.sceneId}`,total,paidAmount:paid,acceptedChange:paid-total+(options.badChange?1:0)}};
 let eventInserted=false;let prior:any;
 const query=vi.fn(async(sql:string)=>sql.includes('FROM action_tokens')?{rows:[token],rowCount:1}:sql.includes('FROM transactions')?{rows,rowCount:rows.length}:{rows:[],rowCount:0});
 const insertRecord=vi.fn(async(_c:any,record:any,_bytes:any,_hash:any,bindingId:any,namespace:any)=>{expect(eventInserted).toBe(true);expect(record.sequence).toBe(1);if(options.binding){expect(bindingId).toBe('binding');expect(namespace).toBe('ns');}else expect(bindingId).toBeUndefined();});
 const repo={getRun:vi.fn(async()=>run),insertRecord,mutateRun:async(_input:any,apply:any,persist:any)=>{if(prior)return{...prior,replayed:true};const result=await apply({query},run,1);eventInserted=true;await persist({query},run,1,result);prior={result,run,replayed:false};return prior;}} as unknown as PostgresRepository;
 const service=new AuthoritativeRunService(repo,options.binding?async()=>({id:'binding',namespace:'ns'}):undefined);
 return{service,run,rows,query,insertRecord,total};
}
const input={userId:'u',runId:'r',expectedRevision:0,clientActionId:'payment',token:'test-token'};
it('validated excess payment emits one stable canonical record after event insertion with outbox binding',async()=>{const f=setup({binding:true});const result=await f.service.acceptTokenAction(input);expect(result.result.commerceRecords).toHaveLength(1);const record=result.result.commerceRecords[0];expect(record.id).toBe(`commerce:r:${beat.sceneId}:returned_excess`);expect(record).toMatchObject({beatId:beat.beatId,inGameDay:beat.day,actor:'player',kind:'relationship',recipients:['player',beat.npcId]});expect(JSON.parse(record.text)).toMatchObject({total:f.total,acceptedChange:1000});expect(f.insertRecord).toHaveBeenCalledTimes(1);expect((await f.service.acceptTokenAction(input)).replayed).toBe(true);expect(f.insertRecord).toHaveBeenCalledTimes(1);});
it('exact payment emits no relationship cause; optional binding preserves old service callers',async()=>{const exact=setup({exact:true});expect((await exact.service.acceptTokenAction(input)).result.commerceRecords).toEqual([]);expect(exact.insertRecord).not.toHaveBeenCalled();const unbound=setup();await unbound.service.acceptTokenAction(input);expect(unbound.insertRecord).toHaveBeenCalledTimes(1);});
it('mismatched change or forged ledger quantity cannot settle or create memory',async()=>{for(const options of [{badChange:true},{badQuantity:true}]){const f=setup(options);await expect(f.service.acceptTokenAction(input)).rejects.toMatchObject({code:options.badChange?'PAYMENT_MISMATCH':'ORDER_LEDGER_MISMATCH'});expect(f.insertRecord).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.includes("SET state='settled'"))).toBe(false);}});

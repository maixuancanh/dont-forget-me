import { it,expect,vi } from 'vitest';
import { GameplayService } from '../src/gameplay/service.js';
import type { PostgresRepository,AuthoritativeRun } from '../src/persistence/repository.js';
import type { PoolClient } from 'pg';
const run:AuthoritativeRun={id:'r',userId:'u',storyVersion:'v',revision:1,eventSequence:1,checkpoint:{beatId:'b',day:1,sceneId:'s',stepIndex:0,scheduleIndex:0,phase:'dialogue'},state:{},status:'active'};
it('locked action reads stay on transaction connection and reuse resolved binding',async()=>{
 let inTransaction=false;
 const query=vi.fn(async()=>({rows:[],rowCount:0}));
 const c={query} as unknown as PoolClient;
 const repo={pool:{query:vi.fn(async()=>{if(inTransaction)throw Error('POOL_CHECKOUT_WHILE_LOCKED');return{rows:[],rowCount:0};})},getRun:vi.fn(async()=>{if(inTransaction)throw Error('POOL_GETRUN_WHILE_LOCKED');return run;}),insertRecord:vi.fn(async()=>{}),mutateRun:async(_input:unknown,apply:any,persist:any)=>{inTransaction=true;try{const result=await apply(c,run,2);await persist(c,run,2,result);return{result,run,replayed:false};}finally{inTransaction=false;}}} as unknown as PostgresRepository;
 const binding=vi.fn(async()=>{if(inTransaction)throw Error('BINDING_POOL_WHILE_LOCKED');return{id:'binding',namespace:'ns',network:'local' as const};});
 const service=new GameplayService(repo,binding);
 const action={kind:'note' as const,text:'A note',recordIds:[]};const preview=await service.preview('u','r',action);
 const result=await service.commit('u','s','r',{expectedRevision:1,clientActionId:'a',consentHash:preview.consentHash,action});expect(result.result.record.text).toBe('A note');expect(query).toHaveBeenCalled();expect(binding).toHaveBeenCalledTimes(1);
});
it('future recipient rejected before receipt lookup and scope spoof rejected',async()=>{
 const repo={pool:{query:vi.fn(async()=>({rows:[],rowCount:0}))}} as unknown as PostgresRepository;
 const service=new GameplayService(repo,async()=>({id:'b',namespace:'ns',network:'local'}));
 await expect(service.preview('u','r',{kind:'share',recipient:'phuc',recordIds:[]},{lockedRun:run})).rejects.toMatchObject({message:'RECIPIENT_NOT_AVAILABLE'});
 await expect(service.records('other','r',{lockedRun:run})).rejects.toMatchObject({message:'FORBIDDEN'});
});

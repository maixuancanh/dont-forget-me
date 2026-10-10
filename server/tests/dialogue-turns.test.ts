import {it,expect} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Store} from "../src/store.js";
import {DialogueService} from "../src/dialogue/service.js";
import {allowedPacket} from "../src/story/canon.js";
import type {TurnRequest} from "../src/dialogue/contracts.js";
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"dfm-turns-")),store=new Store(join(dir,"state.json"));await store.init();
 await store.transact(s=>{s.users.u={id:"u",name:"Player"};s.runs.r={id:"r",userId:"u",day:1,cursor:0,revision:0,records:[],shares:[],turns:[]};});
 const packet=allowedPacket("v2.Day1_1_Junjun.0",{day:1,npcId:"binh",currentBeatId:"v2.Day1_1_Junjun.0",witnessedEventIds:[],examinedObjectIds:[],presentedRecordIds:[],trust:0,caseReviewOpen:false});
 let calls=0,acks=0,active=true,release: (()=>void)|undefined;
 let delay=false;
 const dependencies={provider:{modelId:"injected-test-model",async complete(){calls++;if(delay)await new Promise<void>(resolve=>{release=resolve;});return {utterance:packet.authorizedPropositions[0]!.meaning,sourceIds:[],expressedPropositionIds:[packet.authorizedPropositions[0]!.id],intent:"answer",actions:[]};}},
  async context(){return {npcId:"binh" as const,userId:"u",runId:"r",day:1,packet,recall:{traceId:"test",sources:[],missingExactRecordIds:[],freshness:"verified_cache" as const},history:[]};},
  assertSession(){if(!active)throw new Error("SESSION_REVOKED");},acknowledge(){acks++;}};
 const service=new DialogueService(store,dependencies);
 const request:TurnRequest={clientTurnId:"t1",expectedRevision:0,npcId:"binh",trigger:"arrival",message:"",beatId:packet.beatId,presentedRecordIds:[]};
 return {service,request,store,calls:()=>calls,acks:()=>acks,revoke:()=>{active=false;},delay:()=>{delay=true;},release:()=>{release?.();},waitCall:async()=>{while(!release)await new Promise(resolve=>setTimeout(resolve,1));},restart:()=>new DialogueService(store,dependencies),close:async()=>{await store.close();await rm(dir,{recursive:true,force:true});}};
}
it("replays durable turn after restart and ACK advances exactly once",async()=>{
 const f=await fixture();try{
  const response=await f.service.request("u","r",f.request);
  expect(await f.store.transact(s=>(s as unknown as {dialogueV2:Record<string,Array<{request:TurnRequest}>>}).dialogueV2.r![0]!.request)).toEqual(f.request);
  expect(f.acks()).toBe(0);expect(await f.restart().request("u","r",f.request)).toEqual(response);expect(f.calls()).toBe(1);
  const first=await f.service.acknowledge("u","r",response.turnId,response.runRevision);
  expect(await f.service.acknowledge("u","r",response.turnId,response.runRevision)).toEqual(first);expect(f.acks()).toBe(1);
 }finally{await f.close();}
});
it("coalesces duplicate send but refuses reused ID with changed input",async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.service.request("u","r",f.request),f.service.request("u","r",f.request)]);
  expect(a).toEqual(b);expect(f.calls()).toBe(1);
  await expect(f.service.request("u","r",{...f.request,message:"changed"})).rejects.toThrow("TURN_ID_REUSED");
 }finally{await f.close();}
});
it("rejects response committed after logout and does not ACK undelivered words",async()=>{
 const f=await fixture();try{
  f.delay();const pending=f.service.request("u","r",f.request);const result=expect(pending).rejects.toThrow("SESSION_REVOKED");
  await f.waitCall();f.revoke();f.release();await result;
  expect(await f.store.transact(s=>s.runs.r!.revision)).toBe(0);expect(f.acks()).toBe(0);
 }finally{await f.close();}
});
it("drops stale generation when another device changes run revision",async()=>{
 const f=await fixture();try{
  f.delay();const pending=f.service.request("u","r",f.request);const result=expect(pending).rejects.toThrow("REVISION_CONFLICT");
  await f.waitCall();await f.store.transact(s=>{s.runs.r!.revision++;});f.release();await result;
 }finally{await f.close();}
});
it("requires outstanding display ACK before next generation and enforces run ownership",async()=>{
 const f=await fixture();try{
  const first=await f.service.request("u","r",f.request);
  await expect(f.service.request("u","r",{...f.request,clientTurnId:"t2",expectedRevision:first.runRevision})).rejects.toThrow("TURN_ACK_REQUIRED");
  await expect(f.service.acknowledge("other","r",first.turnId,first.runRevision)).rejects.toThrow("RUN_UNAVAILABLE");
 }finally{await f.close();}
});

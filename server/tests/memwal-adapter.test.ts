import {it,expect} from "vitest";
import {MemwalRecordAdapter} from "../src/memory/memwal-adapter.js";
import type {MemoryRecordV2} from "../src/domain/contracts.js";
const record:MemoryRecordV2={schemaVersion:2,id:"r1",eventId:"e1",userId:"u1",runId:"run1",sessionId:"s1",sequence:0,storyVersion:"full-memory-v2",beatId:"b1",inGameDay:1,createdAt:"2026-10-09T00:00:00Z",actor:"duy",kind:"conversation",text:"I asked you to keep my statement private.",epistemicStatus:"said",sourceIds:[],originIds:["r1"],recipients:["player","duy"],entityIds:[],propositionIds:[]};
const binding={accountBindingId:"binding1",namespace:"dfm:v2:u1:run1:case",network:"mainnet" as const};
it("persists accepted job before polling and records indexed rather than retrievable",async()=>{
 const order:string[]=[];let submitted="";
 const sdk={async remember(text:string,_namespace:string,options:{idempotencyKey:string}){order.push("submit");submitted=text;expect(options.idempotencyKey).toMatch(/^v2:r1:[a-f0-9]{64}$/);return {job_id:"job1",status:"pending"};},async waitForRememberJob(job:string){expect(job).toBe("job1");order.push("poll");return {blob_id:"blob1",job_id:job,namespace:binding.namespace,owner:"owner1",id:"job1"};},async recall(){return {results:[]};}};
 const adapter=new MemwalRecordAdapter(sdk);
 const receipt=await adapter.write(record,binding,undefined,async()=>{order.push("persist");});
 expect(order).toEqual(["submit","persist","poll"]);expect(JSON.parse(submitted)).toEqual(record);
 expect(receipt.state).toBe("indexed");expect(receipt.lastRecallAt).toBeUndefined();
});
it("resumes accepted v2 job without resubmitting and refuses a different content hash",async()=>{
 let writes=0;
 const sdk={async remember(){writes++;return {job_id:"job1",status:"pending"};},async waitForRememberJob(){return {blob_id:"blob1",job_id:"job1",namespace:binding.namespace,owner:"o",id:"job1"};},async recall(){return {results:[]};}};
 const adapter=new MemwalRecordAdapter(sdk);
 const receipt=await adapter.write(record,binding,undefined,async()=>{});
 await adapter.write(record,binding,{...receipt,state:"accepted",jobId:"job1",blobId:undefined},async()=>{});expect(writes).toBe(1);
 await expect(adapter.write({...record,text:"changed"},binding,{...receipt,state:"accepted",jobId:"job1",blobId:undefined},async()=>{})).rejects.toThrow("RECEIPT_CONTENT_MISMATCH");
});
it("requires exact recalled bytes before marking retrievable",async()=>{
 let text="";
 const sdk={async remember(bytes:string){text=bytes;return {job_id:"job1",status:"pending"};},async waitForRememberJob(){return {blob_id:"blob1",job_id:"job1",namespace:binding.namespace,owner:"o",id:"job1"};},async recall(){return {results:[{blob_id:"blob1",text}]};}};
 const adapter=new MemwalRecordAdapter(sdk);const indexed=await adapter.write(record,binding,undefined,async()=>{});
 const proof=await adapter.verifyRecall(record,indexed,"private statement");expect(proof.state).toBe("retrievable");
 text=text.replace("private","public");await expect(adapter.verifyRecall(record,indexed,"statement")).rejects.toThrow("CONTENT_HASH_MISMATCH");
});
it("does not pretend semantic top-K proves an arbitrary exact reference",async()=>{
 const sdk={async remember(){return {job_id:"job1",status:"pending"};},async waitForRememberJob(){return {blob_id:"blob1",job_id:"job1",namespace:binding.namespace,owner:"o",id:"job1"};},async recall(){return {results:[]};}};
 const adapter=new MemwalRecordAdapter(sdk);const indexed=await adapter.write(record,binding,undefined,async()=>{});
 await expect(adapter.verifyRecall(record,indexed,"missing")).rejects.toThrow("EXACT_CONTENT_NOT_RECALLED");
});

import type {MemoryRecordV2,MemoryReceipt} from "../domain/contracts.js";
import {memoryReceiptSchema} from "../domain/schemas.js";
import {serializeMemoryRecord,verifySerializedRecord} from "../domain/serialization.js";

export interface RecordMemorySdk {
 remember(text:string,namespace:string,options:{idempotencyKey:string}):Promise<{job_id:string;status:string}>;
 waitForRememberJob(jobId:string,options:{timeoutMs:number}):Promise<{blob_id:string;job_id?:string;namespace:string;owner:string;id:string}>;
 recall(options:{query:string;namespace:string;limit:number}):Promise<{results:Array<{blob_id:string;text:string}>}>;
}
export interface AccountScope {accountBindingId:string;namespace:string;network:"mainnet"|"local"}

/** Binding is server-resolved. Outbox owns leases and accepted receipt persistence.
 * Local injected SDK calls are test evidence only; no network inferred from URL.
 */
export class MemwalRecordAdapter {
 constructor(private sdk:RecordMemorySdk,private clock:()=>Date=()=>new Date()){}
 async write(record:MemoryRecordV2,binding:AccountScope,previous:MemoryReceipt|undefined,onAccepted:(receipt:MemoryReceipt)=>Promise<void>):Promise<MemoryReceipt>{
  const serialized=serializeMemoryRecord(record);
  if(previous){
   memoryReceiptSchema.parse(previous);
   if(previous.recordId!==record.id||previous.contentHash!==serialized.contentHash||previous.accountBindingId!==binding.accountBindingId||previous.namespace!==binding.namespace||previous.network!==binding.network)throw new Error("RECEIPT_CONTENT_MISMATCH");
   if(["indexed","retrievable"].includes(previous.state))return {...previous};
  }
  let accepted:MemoryReceipt;
  if(previous?.jobId)accepted={...previous,state:"accepted"};
  else{
   const submission=await this.sdk.remember(serialized.bytes,binding.namespace,{idempotencyKey:`v2:${record.id}:${serialized.contentHash}`});
   if(!submission.job_id)throw new Error("INVALID_ACCEPTED_JOB");
   accepted=memoryReceiptSchema.parse({recordId:record.id,...binding,contentHash:serialized.contentHash,state:"accepted",jobId:submission.job_id});
   await onAccepted(accepted);
  }
  const result=await this.sdk.waitForRememberJob(accepted.jobId!,{timeoutMs:30000});
  if(result.namespace!==binding.namespace||!result.owner||!result.blob_id||(result.job_id&&result.job_id!==accepted.jobId))throw new Error("JOB_SCOPE_MISMATCH");
  return memoryReceiptSchema.parse({...accepted,state:"indexed",blobId:result.blob_id,verifiedAt:this.clock().toISOString()});
 }
 async verifyRecall(record:MemoryRecordV2,receipt:MemoryReceipt,query:string):Promise<MemoryReceipt>{
  memoryReceiptSchema.parse(receipt);
  const serialized=serializeMemoryRecord(record);
  if(receipt.recordId!==record.id||receipt.contentHash!==serialized.contentHash||!receipt.blobId||!["indexed","retrievable"].includes(receipt.state))throw new Error("RECEIPT_CONTENT_MISMATCH");
  const recalled=await this.sdk.recall({query,namespace:receipt.namespace,limit:20});
  const found=recalled.results.find(item=>item.blob_id===receipt.blobId);
  if(!found)throw new Error("EXACT_CONTENT_NOT_RECALLED");
  const validated=verifySerializedRecord(found.text,receipt.contentHash);
  if(validated.userId!==record.userId||validated.runId!==record.runId||validated.id!==record.id||found.text!==serialized.bytes)throw new Error("RECALLED_SCOPE_MISMATCH");
  return memoryReceiptSchema.parse({...receipt,state:"retrievable",lastRecallAt:this.clock().toISOString(),verifiedAt:this.clock().toISOString()});
 }
}

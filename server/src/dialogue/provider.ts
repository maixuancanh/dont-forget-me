import type { DialogueContext, ModelTurn, SemanticChecker } from './contracts.js';
import { buildPrompt, type PromptMessage } from './prompt.js';
import { assertContext, validateTurn } from './validator.js';
export interface DialogueProvider { readonly modelId:string; complete(messages:PromptMessage[],signal:AbortSignal):Promise<unknown> }
export class GenerationUnavailable extends Error {readonly code='GENERATION_UNAVAILABLE';constructor(readonly reason?:'PROVIDER_RATE_LIMITED'|'PROVIDER_UNAVAILABLE',readonly retryAfterSeconds?:number){super('GENERATION_UNAVAILABLE')}}
export async function generateTurn(provider:DialogueProvider,context:DialogueContext,message:string,options:{semanticChecker?:SemanticChecker;deadlineMs?:number}={}) {
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),Math.min(options.deadlineMs??20000,20000));
 const bounded=<T>(work:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{const abort=()=>reject(new GenerationUnavailable());controller.signal.addEventListener('abort',abort,{once:true});work.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));});
 try {assertContext(context);let rejection:string|undefined;
  for(let attempt=0;attempt<2;attempt++) {
   if(controller.signal.aborted) throw new GenerationUnavailable();
   let raw:unknown;
   try {raw=await bounded(provider.complete(buildPrompt(context,message,rejection),controller.signal));}
   catch(error){if(error instanceof SyntaxError && !controller.signal.aborted){rejection='INVALID_JSON';continue;}throw error;}
   try {const turn:ModelTurn=await bounded(validateTurn(raw,context,options.semanticChecker,controller.signal));return {turn,modelId:provider.modelId,repairCount:attempt};}
   catch(error){if(controller.signal.aborted) throw error;rejection=error instanceof Error?error.message:'INVALID_TURN';}
  }
  throw new GenerationUnavailable();
 }catch(error){
  const candidate=error as {reason?:unknown;retryAfterSeconds?:unknown};
  const reason=candidate?.reason==='PROVIDER_RATE_LIMITED'||candidate?.reason==='PROVIDER_UNAVAILABLE'?candidate.reason:undefined;
  const retry=typeof candidate?.retryAfterSeconds==='number'?candidate.retryAfterSeconds:undefined;
  throw new GenerationUnavailable(reason,retry);
 } finally {clearTimeout(timer);controller.abort();}
}

import type { EvalCase } from '../tests/fixtures/dialogue-eval-context.js';
import { evalContext } from '../tests/fixtures/dialogue-eval-context.js';
import type { DialogueContext } from '../src/dialogue/contracts.js';
export type EvalVariant = 'memory-on'|'memory-off'|'no-projection'|'no-exact';
export const variants: EvalVariant[] = ['memory-on','memory-off','no-projection','no-exact'];
export function matrix(cases: EvalCase[], repeats = 3) {
 if(cases.length!==60 || new Set(cases.map(c=>c.id)).size!==60) throw new Error('REQUIRE_60_UNIQUE_SCENARIOS');
 if(!Number.isInteger(repeats)||repeats<3) throw new Error('REQUIRE_AT_LEAST_THREE_REPEATS');
 return cases.flatMap(test=>Array.from({length:repeats},(_,repeat)=>variants.map(variant=>({test,repeat:repeat+1,variant})))).flat();
}
export function ablate(context:DialogueContext, variant:EvalVariant):DialogueContext {
 const clone=structuredClone(context);
 if(variant==='memory-off') {clone.history=[];clone.recall.sources=[];}
 if(variant==='no-exact') {clone.recall.sources=clone.recall.sources.filter(s=>s.retrieval!=='exact');clone.history=[];}
 if(clone.projection && variant==='memory-off') {clone.history=[];clone.recall.sources=[];clone.projection.knownRecordIds=[];clone.projection.trustCauseIds=[];clone.projection.activeCommitmentIds=[];clone.projection.unresolvedTopicIds=[];clone.projection.stance='open';clone.projection.stanceCauseIds=[];}
 if(clone.projection && variant==='no-projection') {clone.projection.knownRecordIds=[];clone.projection.trustCauseIds=[];clone.projection.activeCommitmentIds=[];clone.projection.unresolvedTopicIds=[];clone.projection.stance='open';clone.projection.stanceCauseIds=[];}
 if(clone.projection && variant==='no-exact') {clone.recall.sources=clone.recall.sources.filter(s=>s.retrieval!=='exact');clone.history=[];clone.projection.knownRecordIds=[];clone.projection.trustCauseIds=[];clone.projection.activeCommitmentIds=[];clone.projection.stanceCauseIds=[];}
 return clone;
}
export function trialContext(test:EvalCase, variant:EvalVariant) {return ablate(evalContext(test),variant);}
export function percentile(values:number[], p:number) {if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];}
export const trialKey=(id:string,repeat:number,variant:EvalVariant,provider:string)=>JSON.stringify([id,repeat,variant,provider]);
export function providerFailureCategory(status:number,body:unknown){const message=JSON.stringify(body).slice(0,10000);if(/model.{0,100}not supported|unsupported.{0,30}model/i.test(message))return 'MODEL_UNSUPPORTED';return status===429?'PROVIDER_RATE_LIMITED':[401,403,404].includes(status)?'PROVIDER_CONFIGURATION_REJECTED':'PROVIDER_UNAVAILABLE';}
export function safeErrorCategory(error:unknown) {const text=error instanceof Error?error.message:'';return text.includes('EVALUATION_CALL_CAP')?'CALL_CAP':text.includes('EVALUATION_COST_CAP')?'COST_CAP':text.includes('RATE_LIMIT')?'PROVIDER_RATE_LIMITED':text.includes('TIMEOUT')||text.includes('abort')?'TIMEOUT':text.includes('PROVIDER')?'PROVIDER_UNAVAILABLE':'GENERATION_UNAVAILABLE';}
export interface BudgetState {calls:number;reservedCostUsd:number|null;costUsdKnown:number|null;unknownUsageCalls:number}
export class CallBudget {
 private state:BudgetState;
 constructor(private options:{maxCalls:number;costMode:'known'|'unknown';budgetUsd?:number;inputPrice?:number;outputPrice?:number},previous?:BudgetState){
  if(!Number.isInteger(options.maxCalls)||options.maxCalls<1)throw new Error('EXPLICIT_CALL_CAP_REQUIRED');
  if(options.costMode==='known' && (![options.budgetUsd,options.inputPrice,options.outputPrice].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)||!options.budgetUsd))throw new Error('KNOWN_COST_REQUIRES_BUDGET_AND_PRICES');
  this.state=previous?{calls:previous.calls,reservedCostUsd:previous.reservedCostUsd,costUsdKnown:previous.costUsdKnown,unknownUsageCalls:previous.unknownUsageCalls}:{calls:0,reservedCostUsd:options.costMode==='known'?0:null,costUsdKnown:options.costMode==='known'?0:null,unknownUsageCalls:0};
 }
 reserve(inputBound:number){if(this.state.calls>=this.options.maxCalls)throw new Error('EVALUATION_CALL_CAP');
  const cost=this.options.costMode==='known'?(inputBound*this.options.inputPrice!+1600*this.options.outputPrice!)/1e6:null;
  if(cost!==null && this.state.reservedCostUsd!+cost>this.options.budgetUsd!)throw new Error('EVALUATION_COST_CAP');
  this.state.calls++;if(cost!==null)this.state.reservedCostUsd!+=cost;
 }
 usage(usage:any){if(!Number.isFinite(usage?.prompt_tokens)||!Number.isFinite(usage?.completion_tokens)){this.state.unknownUsageCalls++;return;}if(this.options.costMode==='known')this.state.costUsdKnown!+=(usage.prompt_tokens*this.options.inputPrice!+usage.completion_tokens*this.options.outputPrice!)/1e6;}
 snapshot(){return {...this.state};}
}


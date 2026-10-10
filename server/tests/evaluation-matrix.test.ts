import {describe,it,expect} from 'vitest';
import {ablate,matrix,percentile,CallBudget,trialKey,safeErrorCategory,providerFailureCategory} from '../scripts/evaluation-matrix.js';
import {evalContext,type EvalCase} from './fixtures/dialogue-eval-context.js';
describe('evaluation evidence boundaries',()=>{
 it('detects unsupported upstream models without leaking upstream message',()=>{expect(providerFailureCategory(503,{error:{message:"The requested model is not supported by this account. secret"}})).toBe('MODEL_UNSUPPORTED');expect(providerFailureCategory(401,{error:{message:'secret'}})).toBe('PROVIDER_CONFIGURATION_REJECTED');expect(providerFailureCategory(503,{})).toBe('PROVIDER_UNAVAILABLE');});
 it('caps unknown-price calls without reporting zero dollar cost',()=>{const b=new CallBudget({maxCalls:2,costMode:'unknown'});b.reserve(100);b.reserve(100);expect(()=>b.reserve(100)).toThrow('CALL_CAP');expect(b.snapshot().costUsdKnown).toBeNull();});
 it('resumes spent call and reservation counters',()=>{const b=new CallBudget({maxCalls:3,costMode:'known',budgetUsd:1,inputPrice:1,outputPrice:1},{calls:2,reservedCostUsd:0.8,costUsdKnown:0.1,unknownUsageCalls:0});expect(()=>b.reserve(1000000)).toThrow('COST_CAP');expect(b.snapshot().calls).toBe(2);});
 it('does not restore stale derived metrics as budget counters',()=>{
  const saved={calls:12,reservedCostUsd:null,costUsdKnown:null,unknownUsageCalls:0,errorRate:0.75,p95ValidatedResponseMs:19000};
  const budget=new CallBudget({maxCalls:30,costMode:'unknown'},saved);
  expect(budget.snapshot()).toEqual({calls:12,reservedCostUsd:null,costUsdKnown:null,unknownUsageCalls:0});
 });
 it('uses stable unique keys and safe error categories',()=>{expect(trialKey('x',1,'memory-on','A')).not.toBe(trialKey('x',1,'memory-on','B'));expect(safeErrorCategory(new Error('secret url token'))).toBe('GENERATION_UNAVAILABLE');expect(safeErrorCategory(new Error('EVALUATION_CALL_CAP'))).toBe('CALL_CAP');});
 const test:EvalCase={id:'unique-alias',npcId:'duy',history:'neutral',scenario:'fresh-session alias',question:'Which alias?',expected:'accept'};
 it('removes history and every history-bearing projection from fair control without changing original',()=>{const original=evalContext(test);const control=ablate(original,'memory-off');expect(control.history).toEqual([]);expect(control.recall.sources).toEqual([]);expect(control.projection!.stanceCauseIds).toEqual([]);expect(control.projection!.unresolvedTopicIds).toEqual([]);expect(original.history).toHaveLength(1);expect(control.packet).toEqual(original.packet);});
 it('requires unique full suite and repeated paired trials',()=>{expect(()=>matrix([test])).toThrow('REQUIRE_60');const cases=Array.from({length:60},(_,i)=>({...test,id:String(i)}));expect(matrix(cases)).toHaveLength(720);expect(()=>matrix(cases,2)).toThrow('THREE_REPEATS');});
 it('reports empty metrics as unknown and actual tail latency',()=>{expect(percentile([],0.95)).toBeNull();expect(percentile([2,100,1],0.95)).toBe(100);});
});


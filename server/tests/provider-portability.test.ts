import { expect, it, vi } from 'vitest';
import { verifyProviderPortability } from '../src/memory/portability.js';
import { candidate, evalContext, type EvalCase } from './fixtures/dialogue-eval-context.js';
import { operationNamespace } from '../src/memory/operations.js';
const scenario:EvalCase={id:'portable-alias',npcId:'binh',history:'neutral',scenario:'alias',question:'Which alias?',expected:'accept'};
const scope={userId:'eval-user',runId:'eval-run',revision:1,accountBindingId:'eval-binding',owner:'owner',network:'local' as const};
function fixture() {
  const freshContext=vi.fn(async()=>{const c=evalContext(scenario);c.recall.freshness='live';c.recall.sources[0].receipt.blobId='remote-blob';c.recall.sources[0].receipt.namespace=operationNamespace(scope);return c;});
  const primary={deploymentId:'a',runtimeVersion:'runtime-a',safetyEvaluated:true,provider:{modelId:'fixture-primary',complete:vi.fn(async()=>candidate(scenario,await freshContext()))}};
  const secondary={deploymentId:'b',runtimeVersion:'runtime-b',safetyEvaluated:true,provider:{modelId:'fixture-secondary',complete:vi.fn(async()=>candidate(scenario,await freshContext()))}};
  return {scope,primary,secondary,requiredSourceIds:['history:binh:neutral'],question:scenario.question,freshContext};
}
it('fresh model runtimes use same verified blob/source/policy and sanitized traces omit transcript',async()=>{
  const f=fixture(),result=await verifyProviderPortability(f);
  expect(result.consistent).toBe(true);expect(result.traces.map(t=>t.modelId)).toEqual(['fixture-primary','fixture-secondary']);
  expect(result.traces[0].sources).toEqual(result.traces[1].sources);expect(JSON.stringify(result)).not.toContain('Blue Kite');
  expect(f.primary.provider.complete).toHaveBeenCalledOnce();expect(f.secondary.provider.complete).toHaveBeenCalledOnce();
});
it('rejects same-model aliases, unsafe provider and cached memory before claiming swap',async()=>{
  const f=fixture();await expect(verifyProviderPortability({...f,secondary:{...f.secondary,provider:f.primary.provider}})).rejects.toThrow('INDEPENDENT');
  await expect(verifyProviderPortability({...f,secondary:{...f.secondary,safetyEvaluated:false}})).rejects.toThrow('SAFETY');
  const old=await f.freshContext();old.recall.freshness='verified_cache';await expect(verifyProviderPortability({...f,freshContext:async()=>old})).rejects.toThrow('FRESH_MEMORY');
});
it('rejects changed remote blobs and missing account binding despite same semantic text',async()=>{
  const f=fixture(),build=f.freshContext;
  await expect(verifyProviderPortability({...f,freshContext:async id=>{const c=await build();if(id==='b')c.recall.sources[0].receipt.blobId='swapped';return c;}})).rejects.toThrow('SOURCE_DRIFT');
  await expect(verifyProviderPortability({...f,freshContext:async()=>{const c=await build();c.recall.sources[0].receipt.accountBindingId='foreign';return c;}})).rejects.toThrow('SOURCE_UNAVAILABLE');
});

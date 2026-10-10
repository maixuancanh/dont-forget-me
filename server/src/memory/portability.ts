import type { DialogueContext, SemanticChecker } from '../dialogue/contracts.js';
import { generateTurn, type DialogueProvider } from '../dialogue/provider.js';
import { canonicalSerialize, contentHash, serializeMemoryRecord } from '../domain/serialization.js';
import { operationNamespace, type OperationScope } from './operations.js';

export interface PortabilityProvider { provider: DialogueProvider; deploymentId: string; runtimeVersion: string; safetyEvaluated: boolean }
/** Server/operator harness: no player supplied provider URL and no old provider completion is passed into the fresh context. */
export async function verifyProviderPortability(input: { scope: OperationScope; primary: PortabilityProvider; secondary: PortabilityProvider; requiredSourceIds: string[]; question: string; freshContext: (deploymentId: string) => Promise<DialogueContext>; semanticChecker?: SemanticChecker }) {
  if (!input.primary.safetyEvaluated || !input.secondary.safetyEvaluated) throw new Error('PORTABILITY_SAFETY_EVAL_REQUIRED');
  if (input.primary.provider.modelId === input.secondary.provider.modelId || input.primary.deploymentId === input.secondary.deploymentId || !input.primary.runtimeVersion || !input.secondary.runtimeVersion) throw new Error('PORTABILITY_INDEPENDENT_PROVIDER_REQUIRED');
  if (!input.requiredSourceIds.length || new Set(input.requiredSourceIds).size !== input.requiredSourceIds.length) throw new Error('PORTABILITY_REQUIRED_SOURCES');
  const traces = [];
  for (const configured of [input.primary,input.secondary]) {
    const context = await input.freshContext(configured.deploymentId);
    if (context.userId !== input.scope.userId || context.runId !== input.scope.runId || context.recall.freshness !== 'live' || context.recall.missingExactRecordIds.length) throw new Error('PORTABILITY_FRESH_MEMORY_REQUIRED');
    const sourceMap = new Map(context.recall.sources.map(s=>[s.record.id,s]));
    if (context.history.some(r=>!sourceMap.has(r.id) || canonicalSerialize(sourceMap.get(r.id)!.record)!==canonicalSerialize(r))) throw new Error('PORTABILITY_OLD_HISTORY_NOT_ALLOWED');
    const sources = input.requiredSourceIds.map(id=>{
      const s = sourceMap.get(id);
      if (!s || !s.receipt.blobId || s.receipt.accountBindingId !== input.scope.accountBindingId || s.receipt.network !== input.scope.network || s.receipt.namespace !== operationNamespace(input.scope) || s.receipt.contentHash !== serializeMemoryRecord(s.record).contentHash) throw new Error('PORTABILITY_SOURCE_UNAVAILABLE');
      return {recordId:id,blobId:s.receipt.blobId,contentHash:s.receipt.contentHash};
    }).sort((a,b)=>a.recordId.localeCompare(b.recordId));
    const generated = await generateTurn(configured.provider,context,input.question,{semanticChecker:input.semanticChecker});
    if (input.requiredSourceIds.some(id=>!generated.turn.sourceIds.includes(id))) throw new Error('PORTABILITY_MEMORY_NOT_USED');
    traces.push({deploymentId:configured.deploymentId,runtimeVersion:configured.runtimeVersion,modelId:generated.modelId,sources,returnedSourceIds:[...generated.turn.sourceIds].sort(),intent:generated.turn.intent,propositionIds:[...generated.turn.expressedPropositionIds].sort(),utteranceHash:contentHash(generated.turn.utterance)});
  }
  if (canonicalSerialize(traces[0].sources) !== canonicalSerialize(traces[1].sources) || canonicalSerialize(traces[0].propositionIds) !== canonicalSerialize(traces[1].propositionIds) || traces[0].intent !== traces[1].intent) throw new Error('PORTABILITY_POLICY_OR_SOURCE_DRIFT');
  return {consistent:true as const,traces,proofBoundary:'provider_calls_with_fresh_verified_memory' as const};
}

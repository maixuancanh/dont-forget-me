import type {MemoryRecordV2} from '../domain/contracts.js';
const mutableKinds=new Set(['hypothesis','interpretation','correction']);
/** Unicode tokenization defines boundaries; alias text remains data, never prompt instructions. */
export function aliasTokens(text:string):string[]{return text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}\p{M}]+/gu)??[];}
function indexScoped(records:readonly MemoryRecordV2[],userId:string,runId:string){
 const index=new Map<string,MemoryRecordV2>();
 for(const r of records){if(r.userId!==userId||r.runId!==runId)continue;if(index.has(r.id))throw Error('INTERPRETATION_DUPLICATE_ID');index.set(r.id,r);}
 return index;
}
/** Input must already exclude unacknowledged turns and deleted/unavailable ledger sources. */
export function queryAliasTargets(records:readonly MemoryRecordV2[],userId:string,runId:string,query:string):string[]{
 const index=indexScoped(records,userId,runId);const queryTerms=aliasTokens(query);const targets=new Set<string>();
 for(const alias of index.values()){
  if(alias.kind!=='alias'||alias.actor!=='player'||!alias.recipients.includes('player'))continue;
  const tokens=aliasTokens(alias.text);if(!tokens.length||alias.text.length>80||alias.sourceIds.length!==1)continue;
  const target=index.get(alias.sourceIds[0]);if(!target||target.sequence>alias.sequence||!target.recipients.includes('player'))continue;
  const matches=queryTerms.some((_,position)=>tokens.every((token,offset)=>queryTerms[position+offset]===token));
  if(matches)targets.add(target.id);
 }
 return [...targets].sort();
}
/** Preserve immutable original quotes. Only current player-authored interpretation leaves are active. */
export function activeInterpretations(records:readonly MemoryRecordV2[],userId:string,runId:string):MemoryRecordV2[]{
 const index=indexScoped(records,userId,runId);const candidates=[...index.values()].filter(r=>r.actor==='player'&&mutableKinds.has(r.kind)&&r.recipients.includes('player'));const children=new Map<string,MemoryRecordV2>();
 for(const r of candidates){
  if(r.sourceIds.some(id=>{const source=index.get(id);return !source||source.sequence>r.sequence;}))throw Error('INTERPRETATION_SOURCE_UNAVAILABLE');
  if(!r.supersedesId)continue;
  const parent=index.get(r.supersedesId);if(!parent)throw Error('CORRECTION_SOURCE_UNAVAILABLE');
  if(parent.actor!=='player'||!mutableKinds.has(parent.kind)||!parent.recipients.includes('player'))throw Error('ORIGINAL_QUOTE_READ_ONLY');
  if(r.kind!=='correction'||r.sequence<=parent.sequence)throw Error('CORRECTION_STALE');
  if(children.has(parent.id))throw Error('CORRECTION_BRANCH_CONFLICT');
  if(!r.sourceIds.includes(parent.id))throw Error('CORRECTION_SOURCE_LINK_REQUIRED');
  children.set(parent.id,r);
 }
 // Chronological edges prohibit cycles. Keep only final leaves; ancestors remain unchanged in ledger.
 return candidates.filter(r=>!children.has(r.id)).sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id)).map(r=>structuredClone(r));
}

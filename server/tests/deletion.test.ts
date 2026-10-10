import { it, expect } from 'vitest';
import { deletionScope } from '../src/memory/deletion.js';
import type { MemoryRecordV2 } from '../src/domain/contracts.js';
import { validateBudget } from '../src/memory/budget.js';
it('blocks transitive sources, origins and corrections in exact sorted scope',()=>{
 const records=[{id:'a',sourceIds:[],originIds:['a']},{id:'b',sourceIds:['a'],originIds:['b']},{id:'c',sourceIds:[],originIds:['b']},{id:'d',sourceIds:[],originIds:[],supersedesId:'c'},{id:'other',sourceIds:[],originIds:[]} ] as unknown as MemoryRecordV2[];
 expect(deletionScope(records,[],['a']).recordIds).toEqual(['a','b','c','d']);expect(()=>deletionScope(records,[],['missing'])).toThrow('DELETE_RECORD_UNAVAILABLE');
});
it('uses integer WAL units and rejects expired quotes and ceiling overruns',()=>{const q={amount:'90071992547409930',currency:'WAL' as const,epochs:2,expiresAt:new Date(Date.now()+100000).toISOString()};expect(()=>validateBudget(q,'90071992547409929')).toThrow();expect(()=>validateBudget(q,q.amount)).not.toThrow();expect(()=>validateBudget({...q,expiresAt:'invalid'},q.amount)).toThrow();});

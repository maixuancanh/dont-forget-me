import {describe,it,expect} from 'vitest';
import {projectStatementHistory,validateStatementRevision,selectArrivalRecall,acknowledgeArrivalRecall,type ArrivalRecallInput} from '../src/gameplay/history.js';
import type {MemoryRecordV2} from '../src/domain/contracts.js';
const scope={userId:'u',runId:'r',storyVersion:'v',npcId:'hanh' as const,sequence:10,inGameDay:3};
const record=(id:string,patch:Partial<MemoryRecordV2>={}):MemoryRecordV2=>({schemaVersion:2,id,eventId:id,userId:'u',runId:'r',sessionId:'s',sequence:1,storyVersion:'v',beatId:'b',inGameDay:1,createdAt:'2026-10-09T00:00:00Z',actor:'hanh',kind:'utterance',text:'I was elsewhere.',epistemicStatus:'said',sourceIds:[],originIds:[id],recipients:['player'],entityIds:['ledger'],propositionIds:['cover'],...patch});
const input=():ArrivalRecallInput=>({scope,records:[record('original'),record('cause',{actor:'player',kind:'relationship',recipients:['hanh'],sequence:2})],projection:{npcId:'hanh',knownRecordIds:['original','cause'],trustCauseIds:['cause'],activeCommitmentIds:['c'],unresolvedTopicIds:['ledger'],stance:'guarded',stanceCauseIds:['cause']},commitments:[{id:'c',type:'task',proposer:'hanh',beneficiary:'player',topicEntityIds:['ledger'],condition:'check_record',targetIds:['ledger'],forbiddenRecipients:[],permittedRecipients:[],status:'accepted',sourceIds:['original']}],acknowledged:[],arrivalComplete:true,deliveryActive:false,horrorActive:false});
describe('statement continuity',()=>{
 it('retains exact originals and revisions after fresh session without asserting truth',()=>{
  const original=record('a');const revision=record('b',{sessionId:'new',sequence:3,supersedesId:'a',sourceIds:['a'],text:'I was there, but left early.',kind:'correction'});
  const history=projectStatementHistory([revision,original],scope);
  expect(history.entries.map(e=>e.record.text)).toEqual([original.text,revision.text]);expect(history.entries[0].revisedByIds).toEqual(['b']);expect(history.entries.every(e=>e.attribution==='historical_utterance')).toBe(true);
  history.entries[0].record.text='mutated';expect(original.text).toBe('I was elsewhere.');
 });
 it('filters unknown evidence, foreign scope and future records',()=>{
  const history=projectStatementHistory([record('a'),record('secret',{actor:'bao',recipients:['player']}),record('leak',{sourceIds:['secret']}),record('indirect',{sourceIds:['leak']}),record('foreign',{runId:'other'}),record('future',{sequence:11}),record('day',{inGameDay:4})],scope);
  expect(history.knownSources.map(r=>r.id)).toEqual(['a']);
 });
 it('requires known causal sources and authored permitted propositions for revisions',()=>{
  const history=projectStatementHistory([record('a'),record('cause',{actor:'player',recipients:['hanh'],sequence:2})],scope);
  const revision=record('b',{sequence:3,supersedesId:'a',sourceIds:['cause'],propositionIds:['revision']});
  const policy={previousRecordId:'a',causeRecordIds:['cause'],permittedPropositionIds:['revision']};expect(validateStatementRevision(revision,history,policy)).toEqual([]);
  expect(validateStatementRevision({...revision,propositionIds:['invented'],sourceIds:['secret']},history,policy)).toEqual(expect.arrayContaining(['UNKNOWN_REVISION_CAUSE','UNKNOWN_REVISION_SOURCE','UNAUTHORIZED_REVISION_PROPOSITION']));
 });
});
describe('arrival recall',()=>{
 it('prioritizes pending commitments and ACK deduplicates reload triggers',()=>{
  const state=input();const candidate=selectArrivalRecall(state)!;expect(candidate.kind).toBe('commitment');
  state.acknowledged=acknowledgeArrivalRecall([],candidate,'turn');expect(selectArrivalRecall(state)?.kind).toBe('topic');expect(acknowledgeArrivalRecall(state.acknowledged,candidate,'turn-again')).toHaveLength(1);
 });
 it('retries the same suggestion after generation timeout or lost acknowledgement',()=>{const state=input();expect(selectArrivalRecall(state)).toEqual(selectArrivalRecall(structuredClone(state)));});
 it('does not greet specially without prior sources or interrupt timed scenes',()=>{
  const state=input();state.records=[];expect(selectArrivalRecall(state)).toBeUndefined();
  for(const patch of [{arrivalComplete:false},{deliveryActive:true},{horrorActive:true}])expect(selectArrivalRecall({...input(),...patch})).toBeUndefined();
 });
 it('excludes completed tasks and secret breach causes',()=>{
  const state=input();state.commitments[0].status='fulfilled';state.projection.unresolvedTopicIds=[];state.records[1].recipients=['player'];expect(selectArrivalRecall(state)).toBeUndefined();
 });
});

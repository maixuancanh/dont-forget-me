import {withoutTombstones} from '../memory/tombstones.js';
import type {AuthoritativeRun,Checkpoint} from '../persistence/repository.js';
import {PostgresRepository} from '../persistence/repository.js';
import {AuthorityError} from '../persistence/transactions.js';
import {beats,STORY_VERSION,type Beat} from './canon.js';
import {NPC_IDS,type NpcId} from '../domain/contracts.js';
export interface RevisitSelection {priorCheckpoint:Checkpoint;selectedBeatId:string;npcId:NpcId;mode:'investigation'|'dossier'}
function selection(run:AuthoritativeRun):RevisitSelection|undefined {return run.state.revisit as RevisitSelection|undefined;}
export function authorizedRevisitBeat(run:AuthoritativeRun):Beat|undefined {
 const selected=selection(run);if(!selected)return undefined;
 const beat=beats.find(b=>b.beatId===selected.selectedBeatId);
 if(run.storyVersion!==STORY_VERSION||run.status!=='active'||!beat||beat.npcId!==selected.npcId||beat.beatId!==run.checkpoint.beatId||beat.sceneId!==run.checkpoint.sceneId||run.checkpoint.day!==6||run.checkpoint.phase!=='dialogue'||beat.revealConditions.serverPrivate||beat.legacyType==='supplemental')throw new AuthorityError('REVISIT_INVALID');
 return beat;
}
/** Called inside the same ACK transaction. Revisit speech never advances the original schedule. */
export function finishRevisit(run:AuthoritativeRun):boolean {
 const selected=selection(run);if(!selected)return false;authorizedRevisitBeat(run);run.checkpoint=structuredClone(selected.priorCheckpoint);delete run.state.revisit;return true;
}
export class RevisitService {
 constructor(private repository:PostgresRepository){}
 private mode(run:AuthoritativeRun){
  if(run.storyVersion!==STORY_VERSION||run.status!=='active'||run.checkpoint.day!==6)throw new AuthorityError('REVISIT_NOT_OPEN');
  if((selection(run)?.priorCheckpoint??run.checkpoint).phase==='complete')return 'dossier' as const;
  if(run.state.outcome==='unresolved')return 'investigation' as const;
  throw new AuthorityError('REVISIT_NOT_OPEN');
 }
 async options(userId:string,runId:string){
  const run=await this.repository.getRun(userId,runId);this.mode(run);
  const rows=await this.repository.pool.query(`SELECT m.payload FROM memory_records m JOIN domain_events e ON e.run_id=m.run_id AND e.event_id=m.event_id LEFT JOIN turns t ON t.run_id=m.run_id AND t.event_id=m.event_id WHERE m.run_id=$1 AND m.user_id=$2 AND (t.status='acknowledged' OR (t.id IS NULL AND e.kind<>'turn_committed'))`,[runId,userId]);
  const admitted=await withoutTombstones(this.repository.pool,userId,runId,rows.rows.map(r=>r.payload));
  const seen=new Set(rows.rows.filter(r=>admitted.some(m=>m.id===r.payload.id)).filter(r=>r.payload.kind==='utterance'&&r.payload.storyVersion===STORY_VERSION&&r.payload.inGameDay<=6).map(r=>r.payload.beatId));
  // Only scenes with an acknowledged speaking beat are replayable; no future or invented witness.
  return beats.filter(b=>seen.has(b.beatId)&&NPC_IDS.includes(b.npcId as NpcId)&&!b.revealConditions.serverPrivate&&b.legacyType!=='supplemental'&&['greeting','conversation','reassurance','confrontation'].includes(b.kind)).map(b=>({beatId:b.beatId,npcId:b.npcId,sceneId:b.sceneId,objective:b.objective}));
 }
 async select(input:{userId:string;runId:string;expectedRevision:number;clientActionId:string;beatId:string}){
  const available=await this.options(input.userId,input.runId);
  return this.repository.mutateRun({...input,eventId:`revisit:${input.clientActionId}`,kind:'revisit_selected',payload:{beatId:input.beatId}},async(c,run)=>{
   const mode=this.mode(run);if(selection(run))throw new AuthorityError('REVISIT_ACTIVE');
   if((await c.query("SELECT id FROM turns WHERE run_id=$1 AND status='committed' LIMIT 1",[run.id])).rowCount)throw new AuthorityError('TURN_ACK_REQUIRED');
   const option=available.find(b=>b.beatId===input.beatId);if(!option)throw new AuthorityError('BEAT_NOT_AVAILABLE');
   const beat=beats.find(b=>b.beatId===option.beatId)!;
   run.state.revisit={priorCheckpoint:structuredClone(run.checkpoint),selectedBeatId:beat.beatId,npcId:beat.npcId as NpcId,mode} satisfies RevisitSelection;
   run.checkpoint={...run.checkpoint,beatId:beat.beatId,sceneId:beat.sceneId,stepIndex:beat.stepIndex,day:6,phase:'dialogue'};
   return {selected:option,mode};
  });
 }
}


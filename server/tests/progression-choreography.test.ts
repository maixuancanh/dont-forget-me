import {it,expect} from 'vitest';
import {progressionBeats,nextProgressionIndex,reachedProgressionBeats} from '../src/runs/service.js';
it('traverses every physical scene in step order including its payment gate without renumbering persisted checkpoints',()=>{
 const visited:number[]=[];let index=0;
 while(index<progressionBeats.length){expect(visited).not.toContain(index);visited.push(index);index=nextProgressionIndex(index);}
 expect(visited).toHaveLength(progressionBeats.length);
 const scenes=new Set(progressionBeats.map(b=>b.sceneId));
 for(const sceneId of scenes){const steps=visited.map(i=>progressionBeats[i]).filter(b=>b.sceneId===sceneId).map(b=>b.stepIndex);expect(steps).toEqual([...steps].sort((a,b)=>a-b));}
});
it('does not repeat an already acknowledged farewell after repairing a legacy payment gate',()=>{
 const payment=progressionBeats.findIndex(b=>b.beatId==='v2.Day1_2_Lucia.payment.12');
 const farewell=progressionBeats.findIndex(b=>b.beatId==='v2.Day1_2_Lucia.16');
 expect(nextProgressionIndex(payment)).toBe(farewell);
 const next=nextProgressionIndex(payment,new Set(['v2.Day1_2_Lucia.16']));
 expect(progressionBeats[next].sceneId).not.toBe('Day1_2_Lucia');
});
it('does not reveal future NPC recipients or task routes at an appended payment index',()=>{
 const payment=progressionBeats.findIndex(b=>b.beatId==='v2.Day1_1_Junjun.payment.10');
 expect(reachedProgressionBeats(payment).every(b=>b.sceneId==='Day1_1_Junjun')).toBe(true);
});

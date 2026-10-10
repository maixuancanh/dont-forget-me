import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export function loadCoverageSnapshot(root){
 const read=p=>readFileSync(resolve(root,p),'utf8');const json=p=>JSON.parse(read(p));
 const prod='game/story/interaction/prod';
 return {scenes:Object.fromEntries(readdirSync(resolve(root,prod)).filter(n=>n.endsWith('.json')).map(n=>[n.slice(0,-5),json(`${prod}/${n}`)])),days:Array.from({length:6},(_,i)=>read(`${prod}/Day${i+1}.tres`)),beats:json('server/story/beats.json').beats,mappings:json('server/story/beats.json').legacyMappings,personas:json('server/story/personas.json').personas,facts:json('server/story/facts.json').propositions,exports:read('game/export_presets.cfg'),legacyPresent:existsSync(resolve(root,'game/story/interaction/legacy')),manager:read('game/scripts/NPCs/Interactions/NPCInteractionManager.gd'),scenePlayer:read('game/scripts/NPCs/Interactions/ScenePlayer.gd'),ending:read('game/scripts/NPCs/Interactions/FinalCutsceneNPCInteraction.gd'),runner:read('game/scripts/Memory/DialogueBeatRunner.gd'),provider:read('server/src/dialogue/provider.ts')};
}
export function auditCoverage(s){
 const issues=[];const issue=(code,path,detail)=>issues.push({code,path,detail});
 const visits=Object.keys(s.scenes).filter(id=>/^Day[1-6]_[1-4]_/.test(id));
 if(visits.length!==24)issue('VISIT_COUNT','game/story/interaction/prod',`Expected 24; observed ${visits.length}`);
 const npcIds=new Set();let dialogueBeats=0;
 const dynamicActor=s.manager.includes('speaking_npc = str(MemoryGame.session.next_event.get("npcId", current_interaction.character_name))')&&s.manager.includes('beat_runner.start(step, speaking_npc)')&&s.manager.includes('MemoryGame.set_npc(speaking_npc.to_lower())');
 for(let day=1;day<=6;day++){
  const refs=[...s.days[day-1].matchAll(/res:\/\/story\/interaction\/prod\/([^"\]]+)\.json/g)].map(m=>m[1]);
  const expected=visits.filter(id=>id.startsWith(`Day${day}_`));
  if(refs.length!==4||new Set(refs).size!==4||expected.some(id=>!refs.includes(id)))issue('DAY_VISIT_MAPPING',`Day${day}.tres`,'Day must reference its four distinct production visits');
 }
 const ids=new Set();
 for(const [sceneId,scene] of Object.entries(s.scenes)){
  const path=`game/story/interaction/prod/${sceneId}.json`;
  const exportedText=JSON.stringify(scene);
  for(const fact of s.facts.filter(p=>p.disclosure==='never_prompt'||p.revealConditions?.serverPrivate))if(exportedText.includes(fact.id)||(fact.meaning?.length>20&&exportedText.includes(fact.meaning)))issue('PRIVATE_FACT_EXPORT',path,'Server-private proposition content in client JSON');
  npcIds.add(scene.character_name.toLowerCase());
  if(scene.requires_generated_dialogue!==true)issue('RUNNER_NOT_REQUIRED',path,'Generated runner must be mandatory');
  for(const [i,step] of scene.interactions.entries()){
   if(['say','choice'].includes(step.type)||Object.hasOwn(step,'sentence'))issue('STATIC_PRODUCTION_DIALOGUE',`${path}:${i}`,'Static NPC speech/choice');
   if(step.type!=='dialogue_beat')continue;dialogueBeats++;
   if(ids.has(step.beat_id))issue('DUPLICATE_BEAT',`${path}:${i}`,step.beat_id);ids.add(step.beat_id);
   const b=s.beats.find(b=>b.beatId===step.beat_id);const m=s.mappings.find(m=>m.legacyEventId===step.legacy_event_id);
   // Old choice rows were not persisted testimony; only historical say records require migration mapping.
   if(!b||b.sceneId!==sceneId||b.stepIndex!==i||(!dynamicActor&&b.npcId!==scene.character_name.toLowerCase())||b.legacyEventId!==step.legacy_event_id||(b.legacyType==='say'&&(!m||m.beatId!==step.beat_id)))issue('BEAT_MAPPING',`${path}:${i}`,'Missing or mismatched server beat/provenance');
   if(!b)continue;
   if(JSON.stringify(step.input_labels??[])!==JSON.stringify(b.inputLabels))issue('INPUT_LABEL_MAPPING',`${path}:${i}`,step.beat_id);
   if(b.legacyType==='choice'&&(b.inputActions?.length!==b.inputLabels.length||b.inputActions.some(a=>['preview_disclosure','report_selected_evidence'].includes(a.intent)&&(!a.requiresPlayerConfirmation||!a.requiresVerifiedSourceIds))))issue('CHOICE_EVIDENCE_SKIP',`${path}:${i}`,'Evidence choice requires source selection and confirmation');
   for(const id of b.propositionIds)if(!s.facts.some(p=>p.id===id))issue('UNKNOWN_PROPOSITION',`${path}:${i}`,id);
  }
 }
 const expected=['binh','hanh','bao','lan','thu','sau','duy','tuan','phuc'];
 for(const npc of expected)if(!npcIds.has(npc)||!s.personas.some(p=>p.npcId===npc))issue('NPC_COVERAGE',npc,'Missing visit or persona');
 if((!dynamicActor&&!s.manager.includes('beat_runner.start(step, current_interaction.character_name)'))||!s.runner.includes('data.get("generation") != "llm"')||!s.provider.includes('validateTurn(raw,context'))issue('UNVALIDATED_GENERATION_ROUTE','Godot/server dialogue route','Expected generated turn and validator call absent');
 for(const [name,text] of [['ScenePlayer.gd',s.scenePlayer],['FinalCutsceneNPCInteraction.gd',s.ending]]){
  const lines=text.split(/\r?\n/);for(let i=0;i<lines.length;i++)if(lines[i].includes('replace("/prod/", "/legacy/")')&&!lines[i-1]?.includes('and OS.has_feature("standalone")'))issue('LEGACY_RUNTIME_FALLBACK',name,'Static legacy selection is not guarded by explicit standalone feature');
 }
 // NPC-facing commerce scaffolding is also spoken through the speech bubble stack.
 for(const phrase of ['I paid ₫','I need:'])if(s.manager.includes(phrase))issue('STATIC_COMMERCE_SPEECH','NPCInteractionManager.gd',phrase);
 const staticBranch=s.manager.slice(s.manager.indexOf('elif step is InteractionSay:'),s.manager.indexOf('elif step is InteractionWait:'));
 if(staticBranch.includes('say(step.sentence)')&&!/if not OS\.has_feature\("standalone"\):[\s\S]*?\n\s+return[\s\S]*?say\(step\.sentence\)/.test(staticBranch))issue('STATIC_SAY_CALLPATH','NPCInteractionManager.gd','InteractionSay executes fixed authored speech');
 const sections=s.exports.split(/(?=\[preset\.\d+\])/).filter(t=>/^\[preset\.\d+\]/.test(t));
 for(const section of sections){const name=section.match(/name="([^"]+)"/)?.[1]??'unknown';const excluded=section.match(/exclude_filter="([^"]*)"/)?.[1]??'';
  if(s.legacyPresent&&section.includes('*.json')&&!excluded.split(',').some(p=>p.includes('story/interaction/legacy')))issue('LEGACY_EXPORT_LEAK',name,'Legacy exact narrative JSON included in client export');
  if(section.match(/custom_features="[^"]*standalone[^"]*"/))issue('PUBLIC_STANDALONE_FEATURE',name,'Public export enables legacy compatibility');
 }
 return {status:issues.length?'FAIL':'PASS',visits:visits.length,days:6,npcs:[...npcIds].sort(),dialogueBeats,issues,limitations:['Static audit only; not proof of live LLM output or history-dependent semantic variation.','Export policy inspected; binary export contents require separate artifact inspection.']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv.includes('--root')?process.argv[process.argv.indexOf('--root')+1]:resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 try{const report=auditCoverage(loadCoverageSnapshot(root));process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.status==='PASS'?0:1;}catch(e){process.stderr.write(`COVERAGE_UNAVAILABLE: ${e.message}\n`);process.exitCode=2;}
}

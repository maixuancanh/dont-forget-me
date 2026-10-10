import {describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
// Scanner is shared with the standalone Node CLI and intentionally remains JavaScript.
// @ts-expect-error JavaScript scanner has no declaration file.
import {auditCoverage,loadCoverageSnapshot} from '../../tools/qa/dialogue-coverage.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
describe('dynamic coverage scanner',()=>{
 it('maps all 24 visits, nine NPCs, six days and semantic production beats',()=>{
  const report=auditCoverage(loadCoverageSnapshot(root));expect(report.visits).toBe(24);expect(report.npcs).toHaveLength(9);expect(report.dialogueBeats).toBeGreaterThan(100);
  expect(report.issues.filter((i:any)=>['VISIT_COUNT','DAY_VISIT_MAPPING','NPC_COVERAGE','BEAT_MAPPING','UNKNOWN_PROPOSITION','CHOICE_EVIDENCE_SKIP','STATIC_PRODUCTION_DIALOGUE','RUNNER_NOT_REQUIRED','UNVALIDATED_GENERATION_ROUTE'].includes(i.code))).toEqual([]);
 });
 it('detects malformed mappings and disclosure choices that skip evidence',()=>{
  const s=loadCoverageSnapshot(root);const b=s.beats.find((b:any)=>b.legacyType==='choice'&&b.inputLabels.length);b.inputActions=[];
  const scene=s.scenes[b.sceneId];scene.interactions[b.stepIndex].beat_id='missing';
  expect(auditCoverage(s).issues.some((i:any)=>i.code==='BEAT_MAPPING')).toBe(true);
  scene.interactions[b.stepIndex].beat_id=b.beatId;expect(auditCoverage(s).issues.some((i:any)=>i.code==='CHOICE_EVIDENCE_SKIP')).toBe(true);
 });
 it('fails closed for static production dialogue, runtime fallbacks and exported legacy secrets',()=>{
  const s=loadCoverageSnapshot(root);s.scenes.Day1_1_Junjun.interactions[0]={type:'say',sentence:'secret'};s.scenePlayer+='replace("/prod/", "/legacy/")';s.legacyPresent=true;s.exports='[preset.0]\nname="Fixture"\ninclude_filter="*.json"\nexclude_filter=""';
  const report=auditCoverage(s);expect(report.status).toBe('FAIL');expect(report.issues.map((i:any)=>i.code)).toEqual(expect.arrayContaining(['STATIC_PRODUCTION_DIALOGUE','LEGACY_RUNTIME_FALLBACK','LEGACY_EXPORT_LEAK']));
 });
 it('does not interpret fixed commerce NPC replies as generated coverage',()=>{
  const s=loadCoverageSnapshot(root);s.manager+='say("I paid ₫")';expect(auditCoverage(s).issues.some((i:any)=>i.code==='STATIC_COMMERCE_SPEECH')).toBe(true);
 });
 it('detects server-private fact content injected into production export',()=>{
  const s=loadCoverageSnapshot(root);s.facts.push({id:'truth.private-fixture',meaning:'Private answer should never be exported.',disclosure:'never_prompt',revealConditions:{serverPrivate:true}});s.scenes.Day1_1_Junjun.secret='truth.private-fixture';expect(auditCoverage(s).issues.some((i:any)=>i.code==='PRIVATE_FACT_EXPORT')).toBe(true);
 });
 it('requires authoritative mixed-scene actors and excludes standalone from public presets',()=>{
  const s=loadCoverageSnapshot(root);s.manager=s.manager.replace('beat_runner.start(step, speaking_npc)','beat_runner.start(step, current_interaction.character_name)');expect(auditCoverage(s).issues.some((i:any)=>i.code==='BEAT_MAPPING'&&i.path.endsWith('Ending.json:23'))).toBe(true);
  s.exports+='\n[preset.9]\nname="Unsafe public"\ncustom_features="standalone"';expect(auditCoverage(s).issues.some((i:any)=>i.code==='PUBLIC_STANDALONE_FEATURE')).toBe(true);
 });
});

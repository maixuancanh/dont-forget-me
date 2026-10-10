import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { beats, propositions, personas, priceTable, legacyMappings, resolveLegacyEvent, allowedPacket, knowledge, endings, type BeatContext } from "../src/story/canon.js";
const context = (beatId: string, npcId: string, day = 6): BeatContext => ({day,npcId,currentBeatId:beatId,witnessedEventIds:[],examinedObjectIds:[],presentedRecordIds:[],trust:0,caseReviewOpen:true});
it("maps all historical events and supplemental reveal to immutable positions", () => {
  const events = JSON.parse(readFileSync(new URL("../story/legacy-v1-events.json", import.meta.url), "utf8"));
  expect(new Set(legacyMappings.map(m=>m.legacyEventId)).size).toBe(legacyMappings.length);
  for(const event of events) {
    const m=resolveLegacyEvent(event.id); expect(m.legacyStepIndex).toBe(event.stepIndex);
    expect(m.propositionIds.length).toBeGreaterThan(0);
    expect(beats.find(b=>b.beatId===m.beatId)?.sceneId).toBe(event.sceneId);
  }
  expect(resolveLegacyEvent("DuyTrust:0").beatId).toBe("v2.DuyTrust.0");
  expect(()=>resolveLegacyEvent("forged")).toThrow("UNKNOWN_LEGACY_EVENT");
});
it("all orders use actual Vietnamese asset item IDs and VND prices; payment speech requires validation",()=>{
 expect(priceTable.currency).toBe("VND");
 expect(priceTable.items.find(i=>i.itemId==="coffee_strip")?.unitPriceVnd).toBe(10000);
 expect(priceTable.items.find(i=>i.itemId==="candy_mentos")?.unitPriceVnd).toBe(1000);
 expect(priceTable.items.find(i=>i.itemId==="bottled_water")?.unitPriceVnd).toBe(20000);
 for(const beat of beats.filter(b=>b.orderContract)) {
  for(const id of Object.keys(beat.orderContract!.items)) expect(priceTable.items.some(i=>i.itemId===id)).toBe(true);
 }
 const payment=beats.find(b=>b.kind==="payment")!;
 const c=context(payment.beatId,payment.npcId);
 expect(()=>allowedPacket(payment.beatId,c)).toThrow("BEAT_NOT_AVAILABLE");
 c.validatedPayment=true;expect(allowedPacket(payment.beatId,c).kind).toBe("payment");
});
it("input disclosures require actual source selection and consent rather than literal button speech",()=>{
 for(const beat of beats.filter(b=>b.legacyType==="choice")){
  expect(beat.inputActions).toHaveLength(beat.inputLabels.length);
  for(const action of beat.inputActions??[])if(action.intent==="preview_disclosure"||action.intent==="report_selected_evidence"){
   expect(action.requiresPlayerConfirmation).toBe(true);expect(action.requiresVerifiedSourceIds).toBe(true);
  }
 }
});
it("preserves 24 visits and Ending choreography, including numeric purchase links", () => {
 const baseline=JSON.parse(readFileSync(new URL("./fixtures/choreography-baseline.json",import.meta.url),"utf8"));
 expect(Object.keys(baseline.scenes)).toHaveLength(25);
 for(const [sceneId,steps] of Object.entries(baseline.scenes) as Array<[string,any[]]>) {
  const scene=JSON.parse(readFileSync(new URL(`../../game/story/interaction/prod/${sceneId}.json`,import.meta.url),"utf8"));
  expect(scene.interactions).toHaveLength(steps.length);
  steps.forEach((step,i)=>{
   const {stepIndex,...old}=step;
   if(["say","choice"].includes(old.type)){
    const b=beats.find(b=>b.beatId===scene.interactions[i].beat_id)!;
    expect(b.stepIndex).toBe(i);expect(b.legacyType).toBe(old.type);
    expect(b.inputLabels).toEqual(old.response_choices??[]);
    b.propositionIds.forEach(id=>expect(propositions.some(p=>p.id===id)).toBe(true));
   }else expect(scene.interactions[i]).toEqual(old);
  });
 }
});
it("authors every persona and keeps private motives and world truth out of packets",()=>{
 expect(personas.map(p=>p.npcId).sort()).toEqual(["binh","hanh","bao","lan","thu","sau","duy","tuan","phuc"].sort());
 const packet=allowedPacket("v2.Day3_1_Junjun.0",context("v2.Day3_1_Junjun.0","binh",3));
 expect(JSON.stringify(packet)).not.toContain("privateMotives");
 expect(packet.authorizedPropositions.some(p=>p.id.startsWith("truth."))).toBe(false);
 expect(packet.authorizedPropositions[0]?.meaning).toContain("alive");
 expect(()=>allowedPacket("v2.Day6_3_Jomar.10",context("v2.Day6_3_Jomar.10","phuc",5))).toThrow("BEAT_NOT_AVAILABLE");
 expect(()=>allowedPacket("v2.Day6_3_Jomar.10",context("v2.Day5_2_Jomar.5","phuc",6))).toThrow("BEAT_NOT_AVAILABLE");
});
it("keeps timeline-specific persona knowledge and goals out of the entire generation packet",()=>{
 const visits=[
  ["v2.Day1_1_Junjun.0","binh",1],
  ["v2.Day1_4_Layla.0","lan",1],
  ["v2.Day2_2_Malu.0","thu",2],
  ["v2.Day5_2_Jomar.0","phuc",5],
 ] as const;
 for(const [id,npc,day] of visits){
  const packet=allowedPacket(id,context(id,npc,day));
  const text=JSON.stringify(packet);
  const persona=personas.find(p=>p.npcId===npc)!;
  for(const privateLimit of persona.knowledgeLimits)expect(text).not.toContain(privateLimit);
  for(const narrativeGoal of persona.goals)expect(packet.persona?.goals).not.toContain(narrativeGoal);
  expect(text).not.toMatch(/future death|Day4 washing|alive Day3 morning|screened body|family confirmation only Day6|wet slip signature/);
 }
});
it("the protected Duy account needs actual trust, promise and prior testimony",()=>{
 const c=context("v2.DuyTrust.0","duy");
 expect(()=>allowedPacket(c.currentBeatId,c)).toThrow("BEAT_NOT_AVAILABLE");
 Object.assign(c,{trust:2,promise:{id:"protect_duy_from_hanh",kept:true},witnessedEventIds:["Day5_4_Carlo:13"]});
 expect(allowedPacket(c.currentBeatId,c).authorizedPropositions.map(p=>p.id)).toEqual(["p.duy.trusted"]);
 c.promise!.kept=false;expect(()=>allowedPacket(c.currentBeatId,c)).toThrow("BEAT_NOT_AVAILABLE");
});
it("authorized meanings never reveal concealed events through negative instructions",()=>{
 const visits=[
  ["v2.Day1_4_Layla.4","lan",1],
  ["v2.Day3_3_Lucia.6","hanh",3],
  ["v2.Day4_1_Layla.8","lan",4],
  ["v2.Day6_2_Mario.4","sau",6],
 ] as const;
 for(const [id,npc,day]of visits){
  const text=JSON.stringify(allowedPacket(id,context(id,npc,day)));
  expect(text).not.toMatch(/fatal|later incident|did not see a death|pushes Binh|strikes the step/);
 }
});
it("each required evidence category is reachable without trusting Duy or confessing",()=>{
 const route=knowledge.alternativeRoute.sourceIds as string[];
 const tags=new Set<string>();const owners=new Set<string>();
 for(const eventId of route){
  const m=resolveLegacyEvent(eventId),b=beats.find(b=>b.beatId===m.beatId)!;
  const c=context(b.beatId,b.npcId);if(b.sceneId==="Ledger")c.examinedObjectIds=["ledger"];
  const packet=allowedPacket(b.beatId,c);
  packet.authorizedPropositions.forEach(p=>{p.clueTags.forEach(t=>tags.add(t));owners.add(p.owner);});
 }
 expect(endings.resolved.requiredTags.every(t=>tags.has(t))).toBe(true);
 expect(owners.size).toBeGreaterThanOrEqual(endings.resolved.minimumIndependentSpeakers);
 expect(endings.confessionPolicy.automatic).toBe(false);
 for(const b of beats.filter(b=>b.sceneId==="Ending")){
  const packet=allowedPacket(b.beatId,context(b.beatId,b.npcId));
  expect(packet.authorizedPropositions.some(p=>p.clueTags.includes("confession"))).toBe(false);
  expect(packet.authorizedPropositions.some(p=>/I pushed him|I entered the loan/.test(p.meaning))).toBe(false);
 }
});

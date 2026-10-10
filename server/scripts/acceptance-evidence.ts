export interface ParticipantEvidence { participantId:string; consentRecorded:boolean; sessionIds:string[]; memories:Array<{logicalId:string;contentHash:string;meaningfulReviewed:boolean;confirmedReceiptId:string}> }
export function realUseAcceptance(participants:ParticipantEvidence[]) {
 const failures:string[]=[];
 if(new Set(participants.map(p=>p.participantId)).size!==participants.length)failures.push('DUPLICATE_PARTICIPANT');
 if(participants.length<3)failures.push('REQUIRE_THREE_REAL_PARTICIPANTS');
 for(const p of participants){
  if(!p.participantId||!p.consentRecorded)failures.push('PARTICIPANT_CONSENT_MISSING');
  if(new Set(p.sessionIds.filter(Boolean)).size<2)failures.push('REQUIRE_TWO_DISTINCT_SESSIONS');
  const valid=p.memories.filter(m=>m.logicalId&&m.contentHash&&m.meaningfulReviewed&&m.confirmedReceiptId);
  if(new Set(valid.map(m=>m.logicalId)).size<10||new Set(valid.map(m=>m.contentHash)).size<10)failures.push('REQUIRE_TEN_DISTINCT_REVIEWED_CONFIRMED_MEMORIES');
 }
 return {status:failures.length?'BLOCKED_EXTERNAL':'HUMAN_VERIFICATION_REQUIRED',failures:[...new Set(failures)],boundary:'Records alone cannot establish that pseudonymous participants represent real distinct people. Consent and identity verification require operator signoff.'};
}

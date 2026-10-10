(() => {
 const output=document.querySelector('#recovery-status');
 let busy=false;
 async function request(path,body,replayed=false){
  const csrf=await fetch('/v1/auth/csrf',{credentials:'same-origin'}).then(r=>r.json());
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf.csrfToken}:{},body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(response.status===401&&!replayed){
   // Access refresh rotates cookies; acquire the new CSRF token on the bounded replay.
   const access=await fetch('/v1/auth/access',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.csrfToken},body:'{}'});
   if(!access.ok)throw Error('SESSION_INVALID');
   return request(path,body,true);
  }
  if(!response.ok)throw Error(data.error||data.code||'Recovery service unavailable.');return data;
 }
 const messages={TURN_ACK_REQUIRED:'Finish the current conversation in the game, then create the backup again.',RECOVERY_RUN_ALREADY_EXISTS:'This case already exists. Resume it in the game; restore only works for a missing case.',RECOVERY_OUTBOX_IN_FLIGHT:'Memories are still being uploaded. Wait for storage confirmation, then create the backup again.',RECOVERY_INDEX_INCOMPLETE:'Walrus indexing is not complete yet. No complete backup was claimed. Retry after indexing finishes.',RECOVERY_PERSONAL_REBIND_REQUIRED:'Reconnect the owner wallet and grant a new delegate before restoring a personal account.',SESSION_INVALID:'Sign in again, then retry. Your case is saved.'};
 async function action(work){if(busy)return;busy=true;try{await work();}catch(error){output.textContent=messages[error.message]||error.message;}finally{busy=false;}}
 document.querySelector('#recovery-load').onclick=()=>action(async()=>{
  const data=await request('/v2/runs');document.querySelector('#recovery-run').replaceChildren(...data.runs.map(r=>new Option(r.id,r.id)));output.textContent='Choose a case and pause the game before creating a backup.';
 });
 document.querySelector('#recovery-backup').onclick=()=>action(async()=>{
  const runId=document.querySelector('#recovery-run').value;if(!runId)throw Error('Load and select a saved case first.');
  if(!document.querySelector('#recovery-consent').checked)throw Error('Confirm the backup before uploading.');
  output.textContent='Uploading and verifying the signed checkpoint and memory directory…';
  let job=await request(`/v2/runs/${encodeURIComponent(runId)}/memory/manifest`,{confirmed:true});
  for(let count=0;job.status!=='complete'&&count<80;count++){
   output.textContent=job.error?(messages[job.error]||'The backup is pending. Continuing the same upload; no complete backup is claimed.'):'Backup queued. Verifying Walrus uploads; keep the game paused.';
   await new Promise(resolve=>setTimeout(resolve,3000));
   job=await request(`/v2/runs/${encodeURIComponent(runId)}/memory/manifest/${encodeURIComponent(job.operationId)}`);
  }
  if(job.status!=='complete'){output.textContent='Backup still pending. Click Create verified backup again to resume this same checkpoint job. No complete backup is claimed yet.';return;}
  const data=job.result;
  const ticket={schemaVersion:2,userId:data.directory.userId,runId:data.directory.runId,network:'mainnet',directoryBlobId:data.anchor.blobId};
  const url=URL.createObjectURL(new Blob([JSON.stringify(ticket,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`dont-forget-me-${runId}-recovery.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  output.textContent='Verified backup stored in Walrus. Keep the downloaded recovery ticket. Sign in with this same identity when restoring.';
 });
 document.querySelector('#recovery-restore').onclick=()=>action(async()=>{
  const file=document.querySelector('#recovery-ticket').files[0];if(!file||file.size>4096)throw Error('Select a valid small recovery ticket.');
  if(!document.querySelector('#recovery-consent').checked)throw Error('Confirm the restore first.');
  const ticket=JSON.parse(await file.text()),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(ticket.schemaVersion!==2||ticket.network!=='mainnet'||!uuid.test(ticket.userId)||!uuid.test(ticket.runId))throw Error('Invalid recovery ticket.');
  output.textContent='Checking signed Walrus authority, identity, records and tombstones…';
  await request('/v2/memory/authority/restore',{confirmed:true,userId:ticket.userId,runId:ticket.runId});
  output.textContent='Case restored. Return to the game and resume your browser session.';
 });
})();

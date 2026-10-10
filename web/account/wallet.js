(async () => {
// Wallet Standard discovery; private keys remain in the wallet/server vault.
let csrf='';let wallet,account;const wallets=new Set();const status=document.querySelector('#wallet-status');
const register=(...items)=>{for(const item of items)wallets.add(item);renderWallets();return()=>items.forEach(item=>wallets.delete(item));};
window.addEventListener('wallet-standard:register-wallet',event=>event.detail({register}));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register}}));
function renderWallets(){const select=document.querySelector('#wallet-list');select.replaceChildren();for(const w of wallets){const option=document.createElement('option');option.value=w.name;option.textContent=w.name;select.append(option);}}
async function request(path,body){const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error(data.error||'Account operation failed');return data;}
async function refresh(){invalidateMigration();invalidateLifecycle();const me=await request('/v1/auth/me');csrf=me.csrfToken;const data=await request('/v2/ownership/accounts');const list=document.querySelector('#personal-accounts');list.replaceChildren();for(const item of data.accounts){const row=document.createElement('div');const text=document.createElement('p');text.textContent=`${item.account_id} · ${item.status}. Personal access requires a verified migration.`;row.append(text);for(const kind of ['grant','revoke']){const b=document.createElement('button');b.textContent=`Prepare ${kind}`;b.onclick=()=>run(()=>transact(item.id,kind));row.append(b);}list.append(row);}document.querySelector("#migration-account").replaceChildren(...data.accounts.filter(a=>a.status==='delegate_granted').map(a=>new Option(a.account_id,a.id)));const runs=await request('/v2/runs');document.querySelector("#lifecycle-run").replaceChildren(...runs.runs.map(r=>new Option(r.id,r.id)));document.querySelector("#migration-run").replaceChildren(...runs.runs.map(r=>new Option(`${r.id}${data.activeRuns.some(a=>a.id===r.id)?' · personal':' · sponsored'}`,r.id)));}
async function run(work){try{await work();}catch(error){status.textContent=error.message;}}
document.querySelector('#wallet-connect').onclick=()=>run(async()=>{wallet=[...wallets].find(w=>w.name===document.querySelector('#wallet-list').value);if(!wallet?.features['standard:connect'])throw Error('Install a Sui Wallet Standard wallet.');const connected=await wallet.features['standard:connect'].connect();account=connected.accounts.find(a=>a.chains.includes('sui:mainnet'));if(!account)throw Error('Select a Sui mainnet wallet account.');status.textContent=`Connected ${account.address}`;});
document.querySelector('#wallet-link').onclick=()=>run(async()=>{if(!account)throw Error('Connect your wallet first.');const challenge=await request('/v2/ownership/challenge',{accountId:document.querySelector('#memory-account-id').value.trim(),address:account.address});const feature=wallet.features['sui:signPersonalMessage'];if(!feature)throw Error('Wallet lacks personal-message signing.');const result=await feature.signPersonalMessage({account,message:new TextEncoder().encode(challenge.message)});await request('/v2/ownership/prove',{challengeId:challenge.id,signature:result.signature});status.textContent='Owner verified. No memory migration or runtime activation has occurred.';await refresh();});
let walletTransactionBusy=false;
async function transact(id,kind){
 if(!account)throw Error('Connect the account owner wallet first.');
 if(walletTransactionBusy||document.querySelector('#wallet-consent').open)return;
 walletTransactionBusy=true;
 const signingWallet=wallet,signingAccount=account,signingVersion=walletVersion;
 try{
  const prepared=await request(`/v2/ownership/accounts/${encodeURIComponent(id)}/${kind}/prepare`,{});
  if(walletVersion!==signingVersion||wallet!==signingWallet||account!==signingAccount)throw Error('Wallet changed. Prepare a new transaction.');
  const normalize=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{1,64}$/.test(value)?'0x'+value.slice(2).toLowerCase().padStart(64,'0'):null;
  const transactionData=JSON.parse(prepared.transactionJson);
  if(prepared.chain!=='sui:mainnet'||!normalize(transactionData.sender)||normalize(transactionData.sender)!==normalize(signingAccount.address))throw Error('Connect the wallet that owns this memory account.');
  const consent=document.querySelector('#wallet-consent'),confirm=document.querySelector('#wallet-confirm');
  document.querySelector('#wallet-disclosure').textContent=prepared.disclosure;confirm.disabled=false;consent.showModal();
  let consumed=false;
  confirm.onclick=()=>run(async()=>{
   if(consumed||walletTransactionBusy)return;consumed=true;walletTransactionBusy=true;confirm.disabled=true;consent.close();
   try{
    if(walletVersion!==signingVersion||wallet!==signingWallet||account!==signingAccount)throw Error('Wallet changed. Prepare a new transaction.');
    const feature=signingWallet.features['sui:signAndExecuteTransaction'];if(!feature)throw Error('Wallet lacks Sui transaction execution.');
    const transaction={toJSON:async()=>prepared.transactionJson};
    const result=await feature.signAndExecuteTransaction({account:signingAccount,chain:prepared.chain,transaction});
    await request(`/v2/ownership/accounts/${encodeURIComponent(id)}/${kind}/confirm`,{digest:result.digest,intentId:prepared.intentId});
    status.textContent='Transaction effects verified. Sponsored memory remains unchanged pending verified migration.';await refresh();
   }finally{walletTransactionBusy=false;confirm.onclick=null;}
  });
 }finally{walletTransactionBusy=false;}
}
document.querySelector('#wallet-cancel').onclick=()=>document.querySelector('#wallet-consent').close();
let migrationPreview=null,migrationRun='',migrationBusy=false,migrationVersion=0;
const review=document.querySelector('#migration-review');
function invalidateMigration(){migrationVersion++;migrationPreview=null;migrationRun='';review.textContent='';for(const id of ['confirm','status','activate','resume'])document.querySelector('#migration-'+id).disabled=true;}
for(const id of ['run','account'])document.querySelector('#migration-'+id).onchange=invalidateMigration;
async function migrationAction(work){if(migrationBusy)return;migrationBusy=true;try{await work();}catch(error){status.textContent=error.message;}finally{migrationBusy=false;}}
function renderMigration(result){document.querySelector('#migration-resume').disabled=!['partial','requested','executing'].includes(result.status);review.textContent=JSON.stringify(result,null,2);document.querySelector('#migration-activate').disabled=result.status!=='verified';document.querySelector('#migration-status').disabled=false;}
document.querySelector('#migration-preview').onclick=()=>migrationAction(async()=>{invalidateMigration();const version=migrationVersion,runId=document.querySelector('#migration-run').value,accountId=document.querySelector('#migration-account').value;if(!runId||!accountId)throw Error('Select a case and a granted account.');const result=await request(`/v2/runs/${encodeURIComponent(runId)}/ownership/preview`,{personalAccountId:accountId});if(version!==migrationVersion||runId!==document.querySelector('#migration-run').value||accountId!==document.querySelector('#migration-account').value)return;migrationPreview=result;migrationRun=runId;review.textContent=JSON.stringify(result,null,2);document.querySelector('#migration-confirm').disabled=!result.supported;});
const migrationPath=()=>`/v2/runs/${encodeURIComponent(migrationRun)}/ownership/${encodeURIComponent(migrationPreview.id)}`;
document.querySelector('#migration-confirm').onclick=()=>migrationAction(async()=>{if(!migrationPreview?.supported)return;const version=migrationVersion;document.querySelector('#migration-confirm').disabled=true;document.querySelector('#migration-status').disabled=false;status.textContent='Copying and verifying selected case records…';const result=await request(migrationPath()+'/confirm',{confirmed:true,confirmationHash:migrationPreview.confirmationHash});if(version!==migrationVersion)return;renderMigration(result);status.textContent='Copy status received. Activation requires verified status.';});
document.querySelector('#migration-status').onclick=()=>migrationAction(async()=>{if(!migrationPreview)return;const version=migrationVersion,result=await request(migrationPath());if(version===migrationVersion)renderMigration(result);});
document.querySelector('#migration-resume').onclick=()=>migrationAction(async()=>{if(!migrationPreview)return;const version=migrationVersion,result=await request(migrationPath()+'/resume',{});if(version===migrationVersion)renderMigration(result);});
document.querySelector('#migration-activate').onclick=()=>migrationAction(async()=>{if(!migrationPreview)return;const version=migrationVersion,result=await request(migrationPath()+'/activate',{});if(version!==migrationVersion)return;renderMigration(result);status.textContent='Personal account activated. Reopen or refresh the case in the game.';await refresh();invalidateMigration();});



// Wallet lifecycle previews stay bound to the selected case and wallet session.
let lifecycleVersion=0,lifecycleBusy=false,lifecyclePreview=null,lifecycleOperation=null,walletVersion=0;
const lifecycleSelected=new Set(),lifecycleReview=document.querySelector('#lifecycle-review');
const normalizeAddress=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{1,64}$/.test(value)?'0x'+value.slice(2).toLowerCase().padStart(64,'0'):null;
function invalidateLifecycle(){lifecycleVersion++;lifecyclePreview=null;document.querySelector('#lifecycle-confirm').disabled=true;document.querySelector('#lifecycle-consent').checked=false;lifecycleReview.textContent='';}
function walletChanged(){walletVersion++;invalidateLifecycle();invalidateMigration();document.querySelector('#wallet-consent').close();}
const originalConnect=document.querySelector('#wallet-connect').onclick;
document.querySelector('#wallet-connect').onclick=async()=>{walletChanged();await originalConnect();if(wallet?.features['standard:events'])wallet.features['standard:events'].on('change',change=>{walletChanged();if(change.accounts){account=change.accounts.find(a=>a.chains.includes('sui:mainnet'));status.textContent=account?`Connected ${account.address}`:'Wallet disconnected.';}});};
for(const id of ['run','epochs','ceiling'])document.querySelector('#lifecycle-'+id).onchange=()=>{invalidateLifecycle();if(id==='run'){lifecycleSelected.clear();document.querySelector('#lifecycle-sources').replaceChildren();}};
const lifecycleBase=runId=>`/v2/runs/${encodeURIComponent(runId)}/lifecycle`;
async function lifecycleAction(work){if(lifecycleBusy||walletTransactionBusy)return;lifecycleBusy=true;try{await work();}catch(error){status.textContent=error.message;}finally{lifecycleBusy=false;}}
function snapshot(){if(!wallet||!account?.chains.includes('sui:mainnet'))throw Error('Connect a Sui mainnet owner wallet first.');return {wallet,account,walletVersion,version:lifecycleVersion,runId:document.querySelector('#lifecycle-run').value};}
function current(s){return s.wallet===wallet&&s.account===account&&s.walletVersion===walletVersion&&s.version===lifecycleVersion&&s.runId===document.querySelector('#lifecycle-run').value;}
function requireCurrent(s){if(!current(s))throw Error('Wallet or selection changed. Review a new preview.');}
function validatePrepared(prepared,s){if(prepared.chain!=='sui:mainnet')throw Error('Transaction must target Sui mainnet.');const data=JSON.parse(prepared.transactionJson);if(!normalizeAddress(data.sender)||normalizeAddress(data.sender)!==normalizeAddress(s.account.address))throw Error('Prepared transaction sender does not match the connected owner wallet.');if(!prepared.operationId||!prepared.confirmationHash)throw Error('Incomplete transaction preview.');}
document.querySelector('#lifecycle-load').onclick=()=>lifecycleAction(async()=>{invalidateLifecycle();lifecycleSelected.clear();const version=lifecycleVersion,runId=document.querySelector('#lifecycle-run').value;if(!runId)throw Error('Select a case.');const data=await request(lifecycleBase(runId)+'/sources');if(version!==lifecycleVersion)return;status.textContent='Case sources loaded.';const list=document.querySelector('#lifecycle-sources');list.replaceChildren();if(!data.sources.length){const empty=document.createElement('p');empty.textContent='This case has no verified Walrus sources available for this account yet. Play and save a memory before managing storage.';list.append(empty);}for(const source of data.sources){const label=document.createElement('label'),checkbox=document.createElement('input'),text=document.createElement('span');checkbox.type='checkbox';checkbox.value=source.id;checkbox.onchange=()=>{invalidateLifecycle();if(checkbox.checked)lifecycleSelected.add(source.id);else lifecycleSelected.delete(source.id);};text.textContent=`${source.kind}: ${source.text} · objects ${(source.objectIds||[]).join(', ')} · blobs ${(source.blobIds||[]).join(', ')}`;label.append(checkbox,text);list.append(label);}});
async function prepareLifecycle(kind){invalidateLifecycle();const s=snapshot(),recordIds=[...lifecycleSelected];if(!s.runId||!recordIds.length)throw Error('Select a case and its memory sources.');if(kind==='delete'){const feature=s.wallet.features['sui:signPersonalMessage'];if(!feature)throw Error('Wallet lacks personal-message signing.');const challenge=await request(lifecycleBase(s.runId)+'/wallet/challenge',{address:s.account.address});requireCurrent(s);const signed=await feature.signPersonalMessage({account:s.account,message:new TextEncoder().encode(challenge.message??challenge.challenge)});requireCurrent(s);await request(lifecycleBase(s.runId)+'/wallet/authenticate',{challengeId:challenge.id??challenge.challengeId,signature:signed.signature});requireCurrent(s);}
 const body={address:s.account.address,recordIds};if(kind==='renew'){body.epochs=Number(document.querySelector('#lifecycle-epochs').value);body.ceiling=document.querySelector('#lifecycle-ceiling').value.trim();if(!Number.isInteger(body.epochs)||body.epochs<1||body.epochs>53||!/^\d{1,30}$/.test(body.ceiling))throw Error('Enter 1–53 epochs and a maximum WAL cost in base units.');}
 const prepared=await request(lifecycleBase(s.runId)+`/${kind}/prepare`,body);requireCurrent(s);validatePrepared(prepared,s);lifecyclePreview={...s,kind,prepared};lifecycleReview.textContent=JSON.stringify(prepared,null,2);status.textContent='Review the exact objects, owner, transaction and cost before confirming.';
}
for(const kind of ['delete','renew'])document.querySelector('#lifecycle-'+kind).onclick=()=>lifecycleAction(()=>prepareLifecycle(kind));
document.querySelector('#lifecycle-consent').onchange=()=>{document.querySelector('#lifecycle-confirm').disabled=!lifecyclePreview||!document.querySelector('#lifecycle-consent').checked;};
document.querySelector('#lifecycle-confirm').onclick=()=>lifecycleAction(async()=>{const frozen=lifecyclePreview;if(!frozen||!document.querySelector('#lifecycle-consent').checked)return;requireCurrent(frozen);lifecyclePreview=null;document.querySelector('#lifecycle-confirm').disabled=true;document.querySelector('#lifecycle-consent').checked=false;const {prepared,kind}=frozen;validatePrepared(prepared,frozen);lifecycleOperation={runId:frozen.runId,kind,id:prepared.operationId};document.querySelector('#lifecycle-status').disabled=false;const base=lifecycleBase(frozen.runId)+`/${kind}/${encodeURIComponent(prepared.operationId)}`;const transaction={toJSON:async()=>prepared.transactionJson};let result;
 if(kind==='delete'){const feature=frozen.wallet.features['sui:signTransaction'];if(!feature)throw Error('Wallet lacks Sui transaction signing.');const signed=await feature.signTransaction({account:frozen.account,chain:prepared.chain,transaction});requireCurrent(frozen);if(signed.bytes!==prepared.txBytes)throw Error('Wallet returned different transaction bytes. Deletion was not submitted.');result=await request(base+'/submit',{confirmationHash:prepared.confirmationHash,signature:signed.signature,bytes:signed.bytes});}
 else {const feature=frozen.wallet.features['sui:signAndExecuteTransaction'];if(!feature)throw Error('Wallet lacks Sui transaction execution.');const executed=await feature.signAndExecuteTransaction({account:frozen.account,chain:prepared.chain,transaction});result=await request(base+'/confirm',{confirmationHash:prepared.confirmationHash,digest:executed.digest});}
 lifecycleReview.textContent=JSON.stringify(result,null,2);status.textContent='Transaction result received. Check status for verified chain effects.';
});
document.querySelector('#lifecycle-status').onclick=()=>lifecycleAction(async()=>{if(!lifecycleOperation)return;const op=lifecycleOperation,result=await request(lifecycleBase(op.runId)+`/${op.kind}/${encodeURIComponent(op.id)}`);if(op===lifecycleOperation)lifecycleReview.textContent=JSON.stringify(result,null,2);});
renderWallets();await run(refresh);



})().catch(error => { const output = document.querySelector('#status'); if (output) output.textContent = error.message; });

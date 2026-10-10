import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {verifyPersonalMessageSignature} from '@mysten/sui/verify';
import {Transaction} from '@mysten/sui/transactions';
import {generateDelegateKey} from '@mysten-incubation/memwal/account';
import {normalizeSuiAddress,resolveAccountOwner} from '../memory/account-owner.js';
import {resolveMemoryDeployment} from '../memory/exact.js';
import {PostgresRepository} from '../persistence/repository.js';
import {AuthorityError,transaction} from '../persistence/transactions.js';
export interface PersonalAccountOptions {origin:string;relayerUrl:string;encryptionKey:string;resolveOwner?:(id:string)=>Promise<string>;fetch?:typeof fetch}
/** Owner proof links an account; it does not silently migrate or activate it. */
export class PersonalAccountService {
 private fetcher:typeof fetch;
 constructor(private repo:PostgresRepository,private options:PersonalAccountOptions){if(options.encryptionKey.length<32)throw Error('DELEGATE_ENCRYPTION_KEY_REQUIRED');this.fetcher=options.fetch??fetch;}
 async migrate(){await this.repo.pool.query(await readFile(new URL('../../migrations/005_personal_accounts.sql',import.meta.url),'utf8'));}
 async challenge(userId:string,accountId:string,address:string){
  accountId=normalizeSuiAddress(accountId);address=normalizeSuiAddress(address);
  const id=randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString();
  const message=`DON'T FORGET ME personal memory account\nOrigin: ${this.options.origin}\nUser: ${userId}\nAccount: ${accountId}\nWallet: ${address}\nNetwork: sui:mainnet\nNonce: ${id}\nExpires: ${expiresAt}\nThis proves wallet ownership only. It grants no transaction or memory migration permission.`;
  await this.repo.pool.query('INSERT INTO wallet_challenges(id,user_id,account_id,address,message,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,accountId,address,message,expiresAt]);return{id,message,expiresAt};
 }
 async prove(userId:string,id:string,signature:string){
  const row=(await this.repo.pool.query('SELECT * FROM wallet_challenges WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];
  if(!row||row.consumed||new Date(row.expires_at).getTime()<=Date.now())throw new AuthorityError('WALLET_CHALLENGE_INVALID',403);
  try{await verifyPersonalMessageSignature(new TextEncoder().encode(row.message),signature,{address:row.address});}catch{throw new AuthorityError('WALLET_SIGNATURE_INVALID',403);}
  const owner=await(this.options.resolveOwner?.(row.account_id)??resolveAccountOwner(row.account_id,this.options.relayerUrl));
  if(normalizeSuiAddress(owner)!==row.address)throw new AuthorityError('ACCOUNT_OWNER_MISMATCH',403);
  const delegate=await generateDelegateKey();
  const iv=randomBytes(12),key=createHash('sha256').update(this.options.encryptionKey).digest();
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${userId}:${row.account_id}`));
  const encrypted=Buffer.concat([cipher.update(delegate.privateKey,'utf8'),cipher.final()]);
  const secret=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  return transaction(this.repo.pool,async c=>{
   const claimed=await c.query('UPDATE wallet_challenges SET consumed=true WHERE id=$1 AND user_id=$2 AND consumed=false AND expires_at>now() RETURNING id',[id,userId]);if(!claimed.rowCount)throw new AuthorityError('WALLET_CHALLENGE_INVALID',403);
   const account=(await c.query('INSERT INTO personal_memory_accounts(id,user_id,account_id,address,public_key,encrypted_secret) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,account_id) DO UPDATE SET address=EXCLUDED.address RETURNING id,account_id,address,public_key,status',[randomUUID(),userId,row.account_id,row.address,Buffer.from(delegate.publicKey).toString('hex'),secret])).rows[0];
   return{...account,runtimeActivated:false,migrationRequired:true};
  });
 }
 async delegateSecret(userId:string,id:string){
  const row=await this.owned(userId,id);if(row.status!=='delegate_granted')throw new AuthorityError('DELEGATE_NOT_GRANTED',403);
  const data=Buffer.from(row.encrypted_secret,'base64'),key=createHash('sha256').update(this.options.encryptionKey).digest();const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAAD(Buffer.from(`${userId}:${row.account_id}`));decipher.setAuthTag(data.subarray(12,28));return{accountObjectId:row.account_id,owner:row.address,key:Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')};
 }
 async list(userId:string){return{accounts:(await this.repo.pool.query('SELECT id,account_id,address,public_key,status,grant_digest,revoke_digest FROM personal_memory_accounts WHERE user_id=$1 ORDER BY created_at',[userId])).rows,activeRuns:(await this.repo.pool.query("SELECT id,state->>'memoryBindingId' binding_id FROM runs WHERE user_id=$1 AND state->>'memoryAccountMode'='personal'",[userId])).rows};}
 private async owned(userId:string,id:string){const row=(await this.repo.pool.query('SELECT * FROM personal_memory_accounts WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];if(!row)throw new AuthorityError('PERSONAL_ACCOUNT_UNAVAILABLE',403);return row;}
 private async deployment(){const response=await this.fetcher(new URL('/config',this.options.relayerUrl),{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new AuthorityError('ACCOUNT_DEPLOYMENT_UNAVAILABLE',503);try{return resolveMemoryDeployment(await response.json());}catch{throw new AuthorityError('ACCOUNT_DEPLOYMENT_INVALID',503);}}
 async prepare(userId:string,id:string,kind:'grant'|'revoke'){
  const row=await this.owned(userId,id),config=await this.deployment();
  const owner=await(this.options.resolveOwner?.(row.account_id)??resolveAccountOwner(row.account_id,this.options.relayerUrl));if(normalizeSuiAddress(owner)!==row.address)throw new AuthorityError('ACCOUNT_OWNER_MISMATCH',403);
  const tx=new Transaction();tx.setSender(row.address);
  const args=[tx.object(row.account_id),tx.object(config.registryId),tx.pure.vector('u8',Array.from(Buffer.from(row.public_key,'hex')))];
  if(kind==='grant')args.push(tx.pure.string("DON'T FORGET ME personal delegate"),tx.object('0x6'));
  tx.moveCall({target:`${config.packageId}::account::${kind==='grant'?'add_delegate_key':'remove_delegate_key'}`,arguments:args});
  const intentId=randomUUID();await this.repo.pool.query("INSERT INTO delegate_intents(id,user_id,account_id,kind,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[intentId,userId,id,kind]);
  return{intentId,accountId:id,kind,chain:'sui:mainnet',transactionJson:await tx.toJSON(),delegatePublicKey:row.public_key,disclosure:kind==='grant'?'This delegate can access this account across namespaces. Your wallet pays transaction gas. Linking does not migrate sponsored records.':'Revocation is forward-only; it cannot retract plaintext or keys already obtained. Game access to this delegate is disabled after successful verification.'};
 }
 async confirm(userId:string,id:string,kind:'grant'|'revoke',digest:string,intentId:string){
  const row=await this.owned(userId,id),config=await this.deployment();
  const intent=(await this.repo.pool.query("SELECT * FROM delegate_intents WHERE id=$1 AND user_id=$2 AND account_id=$3 AND kind=$4 AND consumed=false AND expires_at>now()",[intentId,userId,id,kind])).rows[0];if(!intent)throw new AuthorityError('DELEGATE_INTENT_INVALID',409);
  const response=await this.fetcher(config.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sui_getTransactionBlock',params:[digest,{showInput:true,showEffects:true}]})});
  const data=(await response.json() as any).result;
  const calls=data?.transaction?.data?.transaction?.transactions;const inputs=data?.transaction?.data?.transaction?.inputs;
  const call=calls?.find((c:any)=>c.MoveCall)?.MoveCall;
  const argument=(n:number)=>{const a=call?.arguments?.[n];return a&&typeof a.Input==='number'?inputs?.[a.Input]:undefined;};
  const hex=(pure:any)=>Array.isArray(pure?.value)?Buffer.from(pure.value).toString('hex'):undefined;
  if(!response.ok||data?.digest!==digest||data?.effects?.status?.status!=='success'||normalizeSuiAddress(data?.transaction?.data?.sender??'invalid')!==row.address||calls?.length!==1||!call||normalizeSuiAddress(call.package)!==config.packageId||call.module!=='account'||call.function!==(kind==='grant'?'add_delegate_key':'remove_delegate_key')||!argument(0)?.objectId||normalizeSuiAddress(argument(0).objectId)!==row.account_id||!argument(1)?.objectId||normalizeSuiAddress(argument(1).objectId)!==config.registryId||hex(argument(2))!==row.public_key||call.arguments.length!==(kind==='grant'?5:3)||(kind==='grant'&&(argument(3)?.value!=="DON'T FORGET ME personal delegate"||!argument(4)?.objectId||normalizeSuiAddress(argument(4).objectId)!==normalizeSuiAddress('0x6')))||!Number.isFinite(Number(data?.timestampMs))||Number(data.timestampMs)<new Date(intent.created_at).getTime()||Number(data.timestampMs)>Date.now()+5000||Number(data.timestampMs)>new Date(intent.expires_at).getTime())throw new AuthorityError('DELEGATE_TRANSACTION_NOT_VERIFIED',409);
  return transaction(this.repo.pool,async c=>{if((await c.query('SELECT id FROM delegate_intents WHERE digest=$1',[digest])).rowCount)throw new AuthorityError('DELEGATE_DIGEST_REUSED',409);const claimed=await c.query('UPDATE delegate_intents SET consumed=true,digest=$2 WHERE id=$1 AND consumed=false AND expires_at>now() RETURNING id',[intentId,digest]);if(!claimed.rowCount)throw new AuthorityError('DELEGATE_INTENT_INVALID',409);
  await c.query(`UPDATE personal_memory_accounts SET status=$3,${kind==='grant'?'grant_digest':'revoke_digest'}=$4 WHERE id=$1 AND user_id=$2`,[id,userId,kind==='grant'?'delegate_granted':'delegate_revoked',digest]);
  return{status:kind==='grant'?'delegate_granted':'delegate_revoked',digest,runtimeActivated:false,migrationRequired:true};});
 }
}

import {beforeAll,afterAll,it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {Ed25519Keypair} from '@mysten/sui/keypairs/ed25519';
import {PostgresRepository} from '../src/persistence/repository.js';
import {PersonalAccountService} from '../src/ownership/binding.js';
import {assertTestDatabase} from '../src/persistence/transactions.js';
const database=process.env.DFM_TEST_DATABASE_URL??'postgresql://dfm_test:dfm_test_fixture_only@127.0.0.1:55449/dfm_test';assertTestDatabase(database);
const schema='ownership_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:database});const pool=new pg.Pool({connectionString:database,max:1,options:`-c search_path=${schema},public`});const repo=new PostgresRepository(pool);
let service:PersonalAccountService,user:string,other:string;const key=Ed25519Keypair.generate(),address=key.getPublicKey().toSuiAddress(),account='0x'+'a'.repeat(64);let owner=address;
beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await repo.migrate();service=new PersonalAccountService(repo,{origin:'http://127.0.0.1:8798',relayerUrl:'https://relayer.memory.walrus.xyz',encryptionKey:'test-delegate-secret-encryption-key-32',resolveOwner:async()=>owner,fetch:async()=>new Response(JSON.stringify({network:'mainnet',packageId:'0x1',registryId:'0x2'}))});await service.migrate();user=await repo.upsertUser('fixture','alice');other=await repo.upsertUser('fixture','bob');});
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
it('real wallet signature proves owner once without activating runtime or exposing private key',async()=>{const challenge=await service.challenge(user,account,address),signed=await key.signPersonalMessage(new TextEncoder().encode(challenge.message));const proved=await service.prove(user,challenge.id,signed.signature);expect(proved.runtimeActivated).toBe(false);expect(proved.migrationRequired).toBe(true);expect(proved.public_key).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(proved)).not.toContain('encrypted_secret');await expect(service.prove(user,challenge.id,signed.signature)).rejects.toMatchObject({code:'WALLET_CHALLENGE_INVALID'});const stored=(await pool.query('SELECT encrypted_secret FROM personal_memory_accounts')).rows[0].encrypted_secret;expect(stored).not.toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(await service.list(user))).not.toContain(stored);});
it('rejects foreign user, wrong wallet, expired nonce and different onchain owner',async()=>{const challenge=await service.challenge(user,account,address),signed=await key.signPersonalMessage(new TextEncoder().encode(challenge.message));await expect(service.prove(other,challenge.id,signed.signature)).rejects.toMatchObject({code:'WALLET_CHALLENGE_INVALID'});const bad=await Ed25519Keypair.generate().signPersonalMessage(new TextEncoder().encode(challenge.message));await expect(service.prove(user,challenge.id,bad.signature)).rejects.toMatchObject({code:'WALLET_SIGNATURE_INVALID'});owner='0x'+'b'.repeat(64);await expect(service.prove(user,challenge.id,signed.signature)).rejects.toMatchObject({code:'ACCOUNT_OWNER_MISMATCH'});owner=address;await pool.query("UPDATE wallet_challenges SET expires_at=now()-interval '1 minute' WHERE id=$1",[challenge.id]);await expect(service.prove(user,challenge.id,signed.signature)).rejects.toMatchObject({code:'WALLET_CHALLENGE_INVALID'});});
it('prepares exact wallet grant/revoke calls with public delegate only and denies foreign accounts',async()=>{const linked=await linkedAccount();const grant=await service.prepare(user,linked.id,'grant');const revoke=await service.prepare(user,linked.id,'revoke');expect(grant.chain).toBe('sui:mainnet');expect(grant.transactionJson).toContain('add_delegate_key');expect(grant.transactionJson).toContain(account);expect(revoke.transactionJson).toContain('remove_delegate_key');expect(JSON.stringify(grant)).not.toContain('encrypted_secret');await expect(service.prepare(other,linked.id,'grant')).rejects.toMatchObject({code:'PERSONAL_ACCOUNT_UNAVAILABLE'});});
import {normalizeSuiAddress} from '../src/memory/account-owner.js';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {schema as configSchema} from '../src/config.js';
const packageId=normalizeSuiAddress('0x1'),registryId=normalizeSuiAddress('0x2'),clockId=normalizeSuiAddress('0x6');
function rpcService(result:()=>unknown){return new PersonalAccountService(repo,{origin:'http://127.0.0.1:8798',relayerUrl:'https://fixture-relayer.invalid',encryptionKey:'test-delegate-secret-encryption-key-32',resolveOwner:async()=>owner,fetch:async(input,init)=>{
 if(new URL(String(input)).pathname==='/config')return new Response(JSON.stringify({network:'mainnet',packageId,registryId,suiRpcUrl:'https://fixture-rpc.invalid'}));
 const request=JSON.parse(String(init?.body));expect(request).toMatchObject({jsonrpc:'2.0',method:'sui_getTransactionBlock',params:[expect.any(String),{showInput:true,showEffects:true}]});return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:result()}));
}});}
function rpcTransaction(linked:any,kind:'grant'|'revoke',digest:string,timestamp=Date.now()+1000){
 // Deliberately reordered inputs prove that MoveCall Input indexes, rather than input-array positions, are authoritative.
 const object=(id:string)=>({type:'object',objectType:'immOrOwnedObject',objectId:id,version:'1',digest:'fixture-object-digest'});
 const inputs=[{type:'pure',valueType:'vector<u8>',value:Array.from(Buffer.from(linked.public_key,'hex'))},object(clockId),{type:'pure',valueType:'0x1::string::String',value:"DON'T FORGET ME personal delegate"},object(registryId),object(account)];
 return {digest,timestampMs:String(timestamp),effects:{status:{status:'success'}},transaction:{data:{sender:address,transaction:{kind:'ProgrammableTransaction',inputs,transactions:[{MoveCall:{package:packageId,module:'account',function:kind==='grant'?'add_delegate_key':'remove_delegate_key',type_arguments:[],arguments:kind==='grant'?[{Input:4},{Input:3},{Input:0},{Input:2},{Input:1}]:[{Input:4},{Input:3},{Input:0}]}}]}}}};
}
it('confirms exact reordered grant/revoke inputs and disables delegate secret after verified revoke',async()=>{
 const linked=await linkedAccount();let response:unknown;const verifier=rpcService(()=>response);
 const grant=await verifier.prepare(user,linked.id,'grant'),grantDigest='fixture-grant-'+randomUUID();response=rpcTransaction(linked,'grant',grantDigest);
 expect(await verifier.confirm(user,linked.id,'grant',grantDigest,grant.intentId)).toMatchObject({status:'delegate_granted',runtimeActivated:false});expect((await verifier.delegateSecret(user,linked.id)).owner).toBe(address);
 const revoke=await verifier.prepare(user,linked.id,'revoke'),revokeDigest='fixture-revoke-'+randomUUID();response=rpcTransaction(linked,'revoke',revokeDigest);
 expect(await verifier.confirm(user,linked.id,'revoke',revokeDigest,revoke.intentId)).toMatchObject({status:'delegate_revoked'});await expect(verifier.delegateSecret(user,linked.id)).rejects.toMatchObject({code:'DELEGATE_NOT_GRANTED'});
});
it('denies wrong account, registry, key, sender, call indexes, label, clock, effects and returned digest',async()=>{
 const linked=await linkedAccount();let response:any;const verifier=rpcService(()=>response);
 const mutations=[(r:any)=>r.transaction.data.transaction.inputs[4].objectId=normalizeSuiAddress('0x77'),(r:any)=>r.transaction.data.transaction.inputs[3].objectId=normalizeSuiAddress('0x78'),(r:any)=>r.transaction.data.transaction.inputs[0].value=[1,2],(r:any)=>r.transaction.data.sender=normalizeSuiAddress('0x79'),(r:any)=>r.transaction.data.transaction.transactions[0].MoveCall.arguments[0]={Input:3},(r:any)=>r.transaction.data.transaction.inputs[2].value='Different grant scope',(r:any)=>r.transaction.data.transaction.inputs[1].objectId=normalizeSuiAddress('0x80'),(r:any)=>r.effects.status.status='failure',(r:any)=>r.digest='another-digest'];
 for(const mutate of mutations){const prepared=await verifier.prepare(user,linked.id,'grant'),digest='fixture-invalid-'+randomUUID();response=rpcTransaction(linked,'grant',digest);mutate(response);await expect(verifier.confirm(user,linked.id,'grant',digest,prepared.intentId)).rejects.toMatchObject({code:'DELEGATE_TRANSACTION_NOT_VERIFIED'});}
});
it('denies successful historical grants, future timestamps, consumed nonce and digest reuse with a new intent',async()=>{
 const linked=await linkedAccount();let response:any;const verifier=rpcService(()=>response);
 for(const offset of [-60000,60000]){const prepared=await verifier.prepare(user,linked.id,'grant'),digest='fixture-time-'+randomUUID();response=rpcTransaction(linked,'grant',digest,Date.now()+offset);await expect(verifier.confirm(user,linked.id,'grant',digest,prepared.intentId)).rejects.toMatchObject({code:'DELEGATE_TRANSACTION_NOT_VERIFIED'});}
 const prepared=await verifier.prepare(user,linked.id,'grant'),digest='fixture-single-'+randomUUID();response=rpcTransaction(linked,'grant',digest);await verifier.confirm(user,linked.id,'grant',digest,prepared.intentId);await expect(verifier.confirm(user,linked.id,'grant',digest,prepared.intentId)).rejects.toMatchObject({code:'DELEGATE_INTENT_INVALID'});
 const newIntent=await verifier.prepare(user,linked.id,'grant');await expect(verifier.confirm(user,linked.id,'grant',digest,newIntent.intentId)).rejects.toMatchObject({code:'DELEGATE_DIGEST_REUSED'});expect((await pool.query('SELECT consumed FROM delegate_intents WHERE id=$1',[newIntent.intentId])).rows[0].consumed).toBe(false);
});
it('wallet proof is bound to current origin, wallet, account and unique nonce',async()=>{
 const first=await service.challenge(user,account,address),second=await service.challenge(user,account,address);expect(first.message).toContain('Origin: http://127.0.0.1:8798');expect(first.message).toContain('Wallet: '+address);expect(first.message).toContain('Account: '+account);expect(first.message).toContain('Nonce: '+first.id);expect(first.message).toContain('Network: sui:mainnet');expect(first.message).not.toBe(second.message);
 const oldSignature=(await key.signPersonalMessage(new TextEncoder().encode(first.message))).signature;await expect(service.prove(user,second.id,oldSignature)).rejects.toMatchObject({code:'WALLET_SIGNATURE_INVALID'});
 const wrongOrigin=(await key.signPersonalMessage(new TextEncoder().encode(second.message.replace('http://127.0.0.1:8798','https://other-origin.invalid')))).signature;await expect(service.prove(user,second.id,wrongOrigin)).rejects.toMatchObject({code:'WALLET_SIGNATURE_INVALID'});
 const fresh=(await key.signPersonalMessage(new TextEncoder().encode(second.message))).signature;expect(await service.prove(user,second.id,fresh)).toMatchObject({account_id:account,address,runtimeActivated:false});
});
it('serves deferred wallet script that parses without module-only syntax',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dfm-wallet-web-')),built=await createApp(configSchema.parse({SESSION_SECRET:'fixture-wallet-web-session-secret-32',DATA_FILE:join(directory,'auth.json')}));
 try{const page=await built.app.inject({url:'/account/'}),script=await built.app.inject({url:'/account/wallet.js'});expect(page.statusCode).toBe(200);expect(page.body).toContain('defer src="wallet.js?v=20261009-2"');expect(script.statusCode).toBe(200);expect(script.headers['content-type']).toContain('javascript');expect(()=>new Function(script.body)).not.toThrow();expect(script.body).toBe(await readFile(new URL('../../web/account/wallet.js',import.meta.url),'utf8'));}
 finally{await built.app.close();await rm(directory,{recursive:true,force:true});}
});

async function linkedAccount(){const prior=(await service.list(user)).accounts[0];if(prior)return prior;const challenge=await service.challenge(user,account,address),signed=await key.signPersonalMessage(new TextEncoder().encode(challenge.message));return service.prove(user,challenge.id,signed.signature);}

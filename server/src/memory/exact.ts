import {EncryptedObject,SealClient,SessionKey,type KeyServerConfig} from '@mysten/seal';
import {Ed25519Keypair} from '@mysten/sui/keypairs/ed25519';
import {decodeSuiPrivateKey} from '@mysten/sui/cryptography';
import {Transaction} from '@mysten/sui/transactions';
import type {SuiClientTypes} from '@mysten/sui/client';
import {blobIdFromInt} from '@mysten/walrus';
import {mainnetWalrusClient} from './walrus-chain.js';
import {normalizeSuiAddress,resolveAccountOwner} from './account-owner.js';
import type {RemoteMemory} from './retrieval.js';

export interface BlobCredentials {accountId:string;key:string}
export interface ExactDependencies {
 authorize(namespace:string):Promise<BlobCredentials>;
 download(blobId:string):Promise<Uint8Array>;
 decrypt(bytes:Uint8Array,credentials:BlobCredentials,namespace:string):Promise<string>;
}
/** Exact storage reference, independent of embedding/index ranking. No plaintext cache/fallback. */
export class AuthorizedBlobReader {
 constructor(private dependencies:ExactDependencies){}
 async read(blobId:string,namespace:string):Promise<RemoteMemory>{
  if(!/^[A-Za-z0-9_:-]{1,200}$/.test(blobId)||!namespace||Buffer.byteLength(namespace)>255)throw Error('EXACT_REFERENCE_INVALID');
  const credentials=await this.dependencies.authorize(namespace);
  const ciphertext=await this.dependencies.download(blobId);
  if(!ciphertext.length||ciphertext.length>1048576)throw Error('EXACT_CIPHERTEXT_SIZE_INVALID');
  const bytes=await this.dependencies.decrypt(ciphertext,credentials,namespace);
  if(Buffer.byteLength(bytes)>524288)throw Error('EXACT_PLAINTEXT_SIZE_INVALID');
  return {blobId,bytes};
 }
}
export function resolveMemoryDeployment(config:{network?:string;packageId?:string;registryId?:string;sealPolicyPackageId?:string;suiRpcUrl?:string;suiGrpcUrl?:string}){
 if(config.network!=='mainnet'||!config.packageId)throw Error('EXACT_DEPLOYMENT_INVALID');
 const packageId=normalizeSuiAddress(config.packageId);
 // Published Mainnet deployment, verified against onchain registry type at use. Never infer unknown registry.
 const published:Record<string,string>={'0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5':'0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f'};
 const registryId=config.registryId??published[packageId];if(!registryId)throw Error('MEMORY_REGISTRY_CONFIGURATION_REQUIRED');
 for(const url of [config.suiRpcUrl,config.suiGrpcUrl])if(url&&new URL(url).protocol!=='https:')throw Error('EXACT_RPC_HTTPS_REQUIRED');
 return {packageId,registryId:normalizeSuiAddress(registryId),policyPackageId:normalizeSuiAddress(config.sealPolicyPackageId??packageId),rpcUrl:config.suiRpcUrl??'https://fullnode.mainnet.sui.io:443'};
}
/** Fresh Seal policy authorization for every read. Owner operations still require browser wallet signing. */
export class MainnetExactStorage {
 private readonly client=mainnetWalrusClient('https://mysten-rpc.mainnet.sui.io');
 constructor(private options:{relayerUrl:string;serverConfigs?:KeyServerConfig[];fetch?:typeof fetch}){}
 private async deployment(){
  const response=await(this.options.fetch??fetch)(new URL('/config',this.options.relayerUrl),{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('EXACT_DEPLOYMENT_UNAVAILABLE');const deployment=resolveMemoryDeployment(await response.json());
  const registry=await this.client.core.getObject({objectId:deployment.registryId});
  if(registry.object.type!==`${deployment.packageId}::account::AccountRegistry`)throw Error('EXACT_REGISTRY_TYPE_MISMATCH');
  return deployment;
 }
 async read(blobId:string,namespace:string,credentials:BlobCredentials,additionalNamespaces:readonly string[]=[]){
  return new AuthorizedBlobReader({authorize:async()=>credentials,download:id=>this.client.walrus.readBlob({blobId:id,signal:AbortSignal.timeout(20000)}),decrypt:async data=>{
   const deployment=await this.deployment(),parsed=EncryptedObject.parse(data);
   if(normalizeSuiAddress(parsed.packageId)!==deployment.packageId)throw Error('EXACT_CIPHERTEXT_PACKAGE_MISMATCH');
   const owner=await resolveAccountOwner(credentials.accountId,this.options.relayerUrl);
   const identity=parsed.id.replace(/^0x/,'');
   if(!/^[a-f0-9]+$/i.test(identity)||identity.length<80||identity.slice(-80,-16).toLowerCase()!==owner.slice(2))throw Error('EXACT_CIPHERTEXT_OWNER_MISMATCH');
   const prefix=identity.slice(0,-80);if(prefix&&![namespace,...additionalNamespaces].some(n=>prefix===Buffer.from(n).toString('hex')))throw Error('EXACT_CIPHERTEXT_NAMESPACE_MISMATCH');
   const key=credentials.key.startsWith('suiprivkey')?decodeSuiPrivateKey(credentials.key).secretKey:Buffer.from(credentials.key.replace(/^0x/,''),'hex');
   if(key.length!==32)throw Error('EXACT_DELEGATE_KEY_INVALID');const signer=Ed25519Keypair.fromSecretKey(key);
   const configs=parsed.services.map(([objectId,weight])=>({objectId,weight,...this.options.serverConfigs?.find(c=>normalizeSuiAddress(c.objectId)===normalizeSuiAddress(objectId))}));
   const seal=new SealClient({suiClient:this.client,serverConfigs:configs,verifyKeyServers:true,timeout:10000});
   const sessionKey=await SessionKey.create({address:signer.toSuiAddress(),packageId:deployment.packageId,ttlMin:1,signer,suiClient:this.client});
   const tx=new Transaction();tx.moveCall({target:`${deployment.policyPackageId}::account::seal_approve`,arguments:[tx.pure.vector('u8',[...Buffer.from(identity,'hex')]),tx.object(deployment.registryId),tx.object(credentials.accountId)]});
   const txBytes=await tx.build({client:this.client,onlyTransactionKind:true});
   const plaintext=await seal.decrypt({data,sessionKey,txBytes});return new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
  }}).read(blobId,namespace);
 }
 /** Exhaustive ownership+namespace enumeration on Sui. Fail closed on cursor loops/scan bounds. */
 async list(namespace:string,credentials:BlobCredentials){
  const deployment=await this.deployment(),owner=await resolveAccountOwner(credentials.accountId,this.options.relayerUrl),type=await this.client.walrus.getBlobType();
  let cursor:string|null=null;const seen=new Set<string>(),blobs:string[]=[];
  for(let pageNumber=0;pageNumber<100;pageNumber++){
   const page:SuiClientTypes.ListOwnedObjectsResponse=await this.client.core.listOwnedObjects({owner,type,cursor,limit:100});
   for(const object of page.objects){
    const attributes=await this.client.walrus.readBlobAttributes({blobObjectId:object.objectId});
    if(attributes?.memwal_namespace!==namespace||!attributes.memwal_package_id||normalizeSuiAddress(attributes.memwal_package_id)!==deployment.packageId)continue;
    const blob=await this.client.walrus.getBlobObject(object.objectId);blobs.push(/^\d+$/.test(String(blob.blob_id))?blobIdFromInt(String(blob.blob_id)):String(blob.blob_id));
   }
   if(!page.hasNextPage)return {blobIds:[...new Set(blobs)],complete:true as const};
   if(!page.cursor||seen.has(page.cursor))throw Error('EXACT_DIRECTORY_CURSOR_INVALID');seen.add(page.cursor);cursor=page.cursor;
  }
  throw Error('EXACT_DIRECTORY_SCAN_LIMIT');
 }
}

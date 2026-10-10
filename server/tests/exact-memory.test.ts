import {expect,it} from 'vitest';
import {AuthorizedBlobReader, resolveMemoryDeployment} from '../src/memory/exact.js';
const creds={accountId:'0x1',key:'fixture-key'};
it('reads a requested blob without any semantic query or local payload',async()=>{
 const calls:string[]=[];const reader=new AuthorizedBlobReader({authorize:async(ns)=>{calls.push('auth:'+ns);return creds;},download:async id=>{calls.push('download:'+id);return new Uint8Array([4]);},decrypt:async(_bytes,c,ns)=>{expect(c).toEqual(creds);expect(ns).toBe('owned');return 'original';}});
 expect(await reader.read('blob','owned')).toEqual({blobId:'blob',bytes:'original'});expect(calls).toEqual(['auth:owned','download:blob']);
});
it('authorizes before accessing storage and never falls back after decryption failure',async()=>{
 let reads=0;const reader=new AuthorizedBlobReader({authorize:async()=>{throw Error('DENIED');},download:async()=>{reads++;return new Uint8Array();},decrypt:async()=>''});await expect(reader.read('blob','foreign')).rejects.toThrow('DENIED');expect(reads).toBe(0);
 const denied=new AuthorizedBlobReader({authorize:async()=>creds,download:async()=>new Uint8Array([1]),decrypt:async()=>{throw Error('REVOKED');}});await expect(denied.read('blob','owned')).rejects.toThrow('REVOKED');
});
it('bounds ciphertext and plaintext and rejects unsafe identifiers',async()=>{
 const reader=new AuthorizedBlobReader({authorize:async()=>creds,download:async()=>new Uint8Array(1048577),decrypt:async()=>''});await expect(reader.read('blob','owned')).rejects.toThrow('SIZE');await expect(reader.read('../blob','owned')).rejects.toThrow('REFERENCE');
});
it('resolves published Mainnet registry omitted by config but rejects unknown deployment',()=>{
 const c={network:'mainnet',packageId:'0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5',suiRpcUrl:'https://rpc-mainnet.suiscan.xyz'};expect(resolveMemoryDeployment(c).registryId).toBe('0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f');expect(()=>resolveMemoryDeployment({...c,packageId:'0x99'})).toThrow('REGISTRY');
});

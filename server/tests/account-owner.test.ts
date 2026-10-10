import { it, expect } from 'vitest';
import { PublicAccountOwnerResolver, normalizeSuiAddress } from '../src/memory/account-owner.js';
const config = { network: 'mainnet', packageId: '0x1', suiRpcUrl: 'https://rpc.example.test' };
const object = { objectId: '0x2', type: '0x1::account::MemWalAccount', content: { dataType: 'moveObject', type: '0x1::account::MemWalAccount', fields: { owner: '0x3' } } };
function fixture(change: (value: typeof object) => void = () => {}) {
  let calls = 0, time = 0;
  const data = structuredClone(object); change(data);
  const fetcher: typeof fetch = async (_url, init) => { calls++; if (!init?.method) return Response.json(config); const body = JSON.parse(String(init.body)); expect(body.method).toBe('sui_getObject'); expect(body.params).toEqual([normalizeSuiAddress('0x2'), { showContent: true, showType: true }]); return Response.json({ result: { data } }); };
  const resolver = new PublicAccountOwnerResolver({ relayerUrl: 'https://relayer.example.test', fetch: fetcher, now: () => time, ttlMs: 100, expectedPackageId: '0x1' });
  return { resolver, calls: () => calls, advance: () => { time += 101; } };
}
it('resolves public Move owner separately from object ID with single-flight and TTL cache', async () => {
  const f = fixture(); const owners = await Promise.all([f.resolver.resolve('0x2'), f.resolver.resolve('0x2')]);
  expect(owners).toEqual([normalizeSuiAddress('0x3'), normalizeSuiAddress('0x3')]); expect(f.calls()).toBe(2);
  expect(await f.resolver.resolve('0x2', '0x3')).toBe(normalizeSuiAddress('0x3')); expect(f.calls()).toBe(2);
  f.advance(); await f.resolver.resolve('0x2'); expect(f.calls()).toBe(4);
});
it('checks expected owner on cached results and rejects malformed account addresses', async () => {
  const f = fixture(); await f.resolver.resolve('0x2');
  await expect(f.resolver.resolve('0x2', '0x4')).rejects.toThrow('OWNER_MISMATCH');
  await expect(f.resolver.resolve('not-an-object')).rejects.toThrow('INVALID_SUI');
});
it('rejects wrong object package/type and missing owner without caching failure', async () => {
  const wrong = fixture(value => { value.content.type = '0x9::account::MemWalAccount'; });
  await expect(wrong.resolver.resolve('0x2')).rejects.toThrow('TYPE_MISMATCH'); await expect(wrong.resolver.resolve('0x2')).rejects.toThrow('TYPE_MISMATCH'); expect(wrong.calls()).toBe(4);
  const missing = fixture(value => { value.content.fields.owner = ''; }); await expect(missing.resolver.resolve('0x2')).rejects.toThrow('INVALID_SUI');
});
it('rejects relayer deployment package changes, nonmainnet configs and RPC failures', async () => {
  const mismatch = new PublicAccountOwnerResolver({ relayerUrl: 'https://relayer.example.test', expectedPackageId: '0x9', fetch: async () => Response.json(config) });
  await expect(mismatch.resolve('0x2')).rejects.toThrow('PACKAGE_MISMATCH');
  const testnet = new PublicAccountOwnerResolver({ relayerUrl: 'https://relayer.example.test', fetch: async () => Response.json({ ...config, network: 'testnet' }) }); await expect(testnet.resolve('0x2')).rejects.toThrow('DEPLOYMENT_INVALID');
  const failed = new PublicAccountOwnerResolver({ relayerUrl: 'https://relayer.example.test', fetch: async (_url, init) => init?.method ? Response.json({ error: { code: -32000 } }) : Response.json(config) }); await expect(failed.resolve('0x2')).rejects.toThrow('OBJECT_UNAVAILABLE');
});

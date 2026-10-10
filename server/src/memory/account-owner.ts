/** Account object ID and its Move owner address are different identities. */
export interface AccountOwnerOptions {
  relayerUrl: string; rpcUrl?: string; expectedPackageId?: string;
  fetch?: typeof fetch; ttlMs?: number; now?: () => number;
}
export function normalizeSuiAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('INVALID_SUI_ADDRESS');
  return '0x' + value.slice(2).toLowerCase().padStart(64, '0');
}
export class PublicAccountOwnerResolver {
  private cache = new Map<string, { owner: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();
  private fetcher: typeof fetch;
  private clock: () => number;
  private ttl: number;
  constructor(private options: AccountOwnerOptions) {
    this.fetcher = options.fetch ?? fetch; this.clock = options.now ?? Date.now; this.ttl = options.ttlMs ?? 60000;
    if (this.ttl < 0 || this.ttl > 300000) throw new Error('INVALID_OWNER_CACHE_TTL');
    if (new URL(options.relayerUrl).protocol !== 'https:' || (options.rpcUrl && new URL(options.rpcUrl).protocol !== 'https:')) throw new Error('PUBLIC_OWNER_HTTPS_REQUIRED');
    if (options.expectedPackageId) normalizeSuiAddress(options.expectedPackageId);
  }
  private async lookup(accountId: string): Promise<string> {
    const configResponse = await this.fetcher(new URL('/config', this.options.relayerUrl), { signal: AbortSignal.timeout(10000) });
    if (!configResponse.ok) throw new Error('PUBLIC_ACCOUNT_CONFIG_UNAVAILABLE');
    const deployment = await configResponse.json() as { network?: string; packageId?: string; suiRpcUrl?: string };
    if (deployment.network !== 'mainnet' || typeof deployment.packageId !== 'string') throw new Error('PUBLIC_ACCOUNT_DEPLOYMENT_INVALID');
    const packageId = normalizeSuiAddress(deployment.packageId);
    if (this.options.expectedPackageId && packageId !== normalizeSuiAddress(this.options.expectedPackageId)) throw new Error('PUBLIC_ACCOUNT_PACKAGE_MISMATCH');
    const rpcUrl = this.options.rpcUrl ?? deployment.suiRpcUrl ?? 'https://fullnode.mainnet.sui.io:443';
    if (new URL(rpcUrl).protocol !== 'https:') throw new Error('PUBLIC_OWNER_HTTPS_REQUIRED');
    const response = await this.fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getObject', params: [accountId, { showContent: true, showType: true }] }) });
    if (!response.ok) throw new Error('PUBLIC_ACCOUNT_RPC_UNAVAILABLE');
    const reply = await response.json() as { error?: unknown; result?: { error?: unknown; data?: { objectId?: string; type?: string; content?: { dataType?: string; type?: string; fields?: { owner?: unknown } } } } };
    if (reply.error || reply.result?.error) throw new Error('PUBLIC_ACCOUNT_OBJECT_UNAVAILABLE');
    const data = reply.result?.data;
    if (!data || typeof data.objectId !== 'string' || normalizeSuiAddress(data.objectId) !== accountId || data.content?.dataType !== 'moveObject') throw new Error('PUBLIC_ACCOUNT_OBJECT_INVALID');
    const expectedType = `${packageId}::account::MemWalAccount`;
    const validType = (type: string | undefined) => {
      const match = type?.match(/^(0x[0-9a-fA-F]{1,64})::account::MemWalAccount$/);
      return Boolean(match && `${normalizeSuiAddress(match[1])}::account::MemWalAccount` === expectedType);
    };
    if (!validType(data.type) || !validType(data.content.type)) throw new Error('PUBLIC_ACCOUNT_TYPE_MISMATCH');
    if (typeof data.content.fields?.owner !== 'string') throw new Error('PUBLIC_ACCOUNT_OWNER_MISSING');
    return normalizeSuiAddress(data.content.fields.owner);
  }
  async resolve(accountObjectId: string, expectedOwner?: string): Promise<string> {
    const accountId = normalizeSuiAddress(accountObjectId), cached = this.cache.get(accountId);
    let owner: string;
    if (cached && cached.expiresAt > this.clock()) owner = cached.owner;
    else {
      let work = this.inflight.get(accountId);
      if (!work) {
        work = this.lookup(accountId).then(value => { this.cache.set(accountId, { owner: value, expiresAt: this.clock() + this.ttl }); return value; }).finally(() => this.inflight.delete(accountId));
        this.inflight.set(accountId, work);
      }
      owner = await work;
    }
    if (expectedOwner && owner !== normalizeSuiAddress(expectedOwner)) throw new Error('PUBLIC_ACCOUNT_OWNER_MISMATCH');
    return owner;
  }
  clear(accountObjectId?: string): void { if (accountObjectId) this.cache.delete(normalizeSuiAddress(accountObjectId)); else this.cache.clear(); }
}

const ownerResolvers = new Map<string, PublicAccountOwnerResolver>();
export function resolveAccountOwner(accountObjectId: string, relayerUrl = 'https://relayer.memory.walrus.xyz', expectedOwner?: string): Promise<string> {
  const normalizedUrl = new URL(relayerUrl).origin;
  let resolver = ownerResolvers.get(normalizedUrl);
  if (!resolver) { resolver = new PublicAccountOwnerResolver({ relayerUrl: normalizedUrl }); ownerResolvers.set(normalizedUrl, resolver); }
  return resolver.resolve(accountObjectId, expectedOwner);
}

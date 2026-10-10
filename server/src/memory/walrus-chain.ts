import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiClientTypes } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey, type Signer } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { walrus, MAINNET_WALRUS_PACKAGE_CONFIG, blobIdFromInt } from '@mysten/walrus';
import type { ChainBlob, LifecycleBlob, LifecycleProvider } from './lifecycle.js';
import { validateBudget, type LifecycleQuote } from './budget.js';
import type { SecurityDeleteOptions } from './security-delete.js';

export function mainnetWalrusClient(url = 'https://fullnode.mainnet.sui.io:443') {
  return new SuiGrpcClient({ network: 'mainnet', baseUrl: url }).$extend(walrus({ packageConfig: MAINNET_WALRUS_PACKAGE_CONFIG }));
}
export type WalrusChainClient = ReturnType<typeof mainnetWalrusClient>;
export type ChainRequest = { operationId: string; kind: 'delete'|'renew'; blobs: ChainBlob[]; quote?: LifecycleQuote; ceiling?: string };
/** Persist this envelope on the server. Never accept an expectation supplied by a browser as trusted proof. */
export interface PreparedLifecycleTransaction { transactionBase64: string; transactionDigest: string; sender: string; request: ChainRequest }

/** Dedicated object-owner key only. MEMWAL_PRIVATE_KEY is an account delegate and is deliberately never read here. */
export function walrusOwnerSigner(secret: string | undefined): Signer | undefined {
  if (!secret) return undefined;
  const decoded = decodeSuiPrivateKey(secret);
  if (decoded.scheme !== 'ED25519') throw Error('WALRUS_OWNER_KEY_SCHEME_UNSUPPORTED');
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}
const sameAddress = (a: string, b: string) => normalizeSuiAddress(a) === normalizeSuiAddress(b);
const id = (value: string) => normalizeSuiAddress(value);
const canonicalBlobId = (value: string) => /^\d+$/.test(value) ? blobIdFromInt(value) : value;

export class WalrusChainProvider implements LifecycleProvider {
  readonly capabilities = { delete: true, renew: true };
  private pending = new Map<string, PreparedLifecycleTransaction>();
  constructor(private options: { rpcUrl?: string; signer?: Signer; clientFactory?: () => WalrusChainClient } = {}) {}
  private client() { return this.options.clientFactory?.() ?? mainnetWalrusClient(this.options.rpcUrl); }

  async securityDeleteOptions(): Promise<Omit<SecurityDeleteOptions, 'baseUrl'|'fetch'>> {
    const system = await this.client().walrus.systemObject();
    return {
      deleteTarget: `${id(system.package_id)}::system::delete_blob`, systemObjectId: MAINNET_WALRUS_PACKAGE_CONFIG.systemObjectId,
      inspect: async objectId => {
        const blob = await this.client().walrus.getBlobObject(objectId);
        return this.inspect({ objectId, blobId: canonicalBlobId(blob.blob_id), network: 'mainnet' });
      },
      // The caller must bind this digest to its stored, validated, signed TransactionData.
      verify: async digest => {
        const result = await this.client().core.waitForTransaction({ digest, include: { effects: true, transaction: true } });
        if (result.$kind !== 'Transaction' || !result.Transaction.status.success || !result.Transaction.effects.status.success || result.Transaction.digest !== digest || result.Transaction.effects.transactionDigest !== digest || !result.Transaction.transaction.sender) throw Error('WALRUS_DELETE_TRANSACTION_FAILED');
        return { digest, successful: true, sender: result.Transaction.transaction.sender,
          deletedObjectIds: result.Transaction.effects.changedObjects.filter(o => o.idOperation === 'Deleted' && o.inputState === 'Exists' && o.outputState === 'DoesNotExist').map(o => o.objectId) };
      },
    };
  }

  async resolveOwnedBlob(blobId: string, owner: string): Promise<ChainBlob> {
    const client = this.client(), matches: string[] = [];
    const type = await client.walrus.getBlobType();
    let cursor: string | null = null;
    const cursors = new Set<string>(); let pages=0;
    do {
      if(++pages>50)throw Error('WALRUS_OWNED_SCAN_LIMIT');
      const page: SuiClientTypes.ListOwnedObjectsResponse = await client.core.listOwnedObjects({ owner: id(owner), type, cursor, limit: 100 });
      for (const object of page.objects) {
        const blob = await client.walrus.getBlobObject(object.objectId);
        if (canonicalBlobId(blob.blob_id) === blobId) matches.push(object.objectId);
      }
      if (!page.hasNextPage) break;
      if (!page.cursor || cursors.has(page.cursor)) throw Error('WALRUS_OWNED_CURSOR_INVALID');
      cursors.add(page.cursor); cursor = page.cursor;
    } while (true);
    if (matches.length !== 1) throw Error(matches.length ? 'WALRUS_BLOB_OBJECT_AMBIGUOUS' : 'WALRUS_OWNED_BLOB_NOT_FOUND');
    const blob = await this.inspect({ blobId, objectId: matches[0], network: 'mainnet' } as LifecycleBlob);
    if (!sameAddress(blob.owner, owner)) throw Error('WALRUS_BLOB_OWNER_CHANGED');
    return blob;
  }

  async inspect(ref: Pick<LifecycleBlob, 'objectId'|'blobId'|'network'>): Promise<ChainBlob> {
    if (ref.network !== 'mainnet' || !ref.objectId) throw Error('WALRUS_MAINNET_OBJECT_REQUIRED');
    const client = this.client();
    const [blob, result, state] = await Promise.all([
      client.walrus.getBlobObject(ref.objectId), client.core.getObject({ objectId: ref.objectId }), client.walrus.systemState(),
    ]);
    if (id(blob.id) !== id(ref.objectId) || canonicalBlobId(blob.blob_id) !== ref.blobId || result.object.owner.$kind !== 'AddressOwner') throw Error('WALRUS_BLOB_IDENTITY_OR_OWNER_INVALID');
    return { objectId: ref.objectId, blobId: ref.blobId, owner: result.object.owner.AddressOwner,
      deletable: blob.deletable, endEpoch: blob.storage.end_epoch, currentEpoch: state.committee.epoch, network: 'mainnet' };
  }

  async authorized(owner: string, objectId: string, _kind: 'delete'|'renew') {
    if (!this.options.signer || !sameAddress(owner, this.options.signer.toSuiAddress())) return false;
    const { object } = await this.client().core.getObject({ objectId });
    return object.owner.$kind === 'AddressOwner' && sameAddress(owner, object.owner.AddressOwner);
  }

  async quote(blobs: readonly ChainBlob[], epochs: number): Promise<LifecycleQuote> {
    if (!Number.isSafeInteger(epochs) || epochs < 1 || !blobs.length) throw Error('WALRUS_RENEW_EPOCHS_INVALID');
    const client = this.client(), state = await client.walrus.systemState();
    let amount = 0n;
    for (const ref of blobs) {
      const blob = await client.walrus.getBlobObject(ref.objectId);
      if (canonicalBlobId(blob.blob_id) !== ref.blobId || blob.storage.end_epoch !== ref.endEpoch || state.committee.epoch >= ref.endEpoch) throw Error('WALRUS_QUOTE_BLOB_STALE');
      // Exact SDK storageUnitsFromSize formula, using encoded storage_size, without the upload write fee.
      const units = (BigInt(blob.storage.storage_size) + 1048575n) / 1048576n;
      amount += units * BigInt(state.storage_price_per_unit_size) * BigInt(epochs);
    }
    return { amount: amount.toString(), currency: 'WAL', epochs, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  async prepare(request: ChainRequest, sender: string): Promise<PreparedLifecycleTransaction> {
    if (!request.blobs.length || new Set(request.blobs.map(b => id(b.objectId))).size !== request.blobs.length) throw Error('WALRUS_BLOB_SCOPE_INVALID');
    for (const blob of request.blobs) {
      const fresh = await this.inspect({ objectId: blob.objectId, blobId: blob.blobId, network: 'mainnet' });
      if (!sameAddress(fresh.owner, sender) || Object.keys(fresh).some(key => fresh[key as keyof ChainBlob] !== blob[key as keyof ChainBlob]) || fresh.currentEpoch >= fresh.endEpoch || (request.kind === 'delete' && !fresh.deletable)) throw Error('WALRUS_BLOB_STATE_OR_AUTHORITY_CHANGED');
    }
    if (request.kind === 'renew') {
      if (!request.quote || !request.ceiling) throw Error('WALRUS_RENEW_BUDGET_REQUIRED');
      validateBudget(request.quote, request.ceiling);
      const fresh = await this.quote(request.blobs, request.quote.epochs);
      if (fresh.amount !== request.quote.amount) throw Error('WALRUS_RENEW_PRICE_CHANGED');
    }
    const client = this.client(), tx = new Transaction(); tx.setSender(id(sender));
    // Supplying a bounded WAL coin prevents the SDK from silently funding a price increase from the wallet.
    let boundedCoin: ReturnType<Transaction['coin']> | undefined;
    if (request.kind === 'renew') {
      const system = await client.walrus.systemObject();
      const fn = await client.core.getMoveFunction({ packageId: system.package_id, moduleName: 'staking', name: 'stake_with_pool' });
      const arg = fn.function.parameters[1]?.body;
      const coinType = arg?.$kind === 'datatype' ? arg.datatype.typeParameters[0] : undefined;
      if (coinType?.$kind !== 'datatype') throw Error('WALRUS_WAL_TYPE_UNAVAILABLE');
      boundedCoin = tx.coin({ type: coinType.datatype.typeName, balance: BigInt(request.quote!.amount) });
    }
    for (const blob of request.blobs) {
      if (request.kind === 'delete') client.walrus.deleteBlobTransaction({ blobObjectId: blob.objectId, owner: id(sender), transaction: tx });
      else await client.walrus.extendBlobTransaction({ blobObjectId: blob.objectId, endEpoch: blob.endEpoch + request.quote!.epochs, walCoin: boundedCoin!, transaction: tx });
    }
    if (boundedCoin) tx.transferObjects([boundedCoin], id(sender));
    const bytes = await tx.build({ client });
    const transactionDigest = await Transaction.from(bytes).getDigest();
    return { transactionBase64: Buffer.from(bytes).toString('base64'), transactionDigest, sender: id(sender), request: structuredClone(request) };
  }

  async execute(request: ChainRequest) {
    if (!this.options.signer) throw Error('WALRUS_OWNER_SIGNER_NOT_CONFIGURED');
    const prepared = await this.prepare(request, this.options.signer.toSuiAddress());
    const bytes = Buffer.from(prepared.transactionBase64, 'base64');
    const signed = await this.options.signer.signTransaction(bytes);
    // Retain expected digest before submission, so a network failure cannot cause an automatic second dispatch.
    this.pending.set(prepared.transactionDigest, prepared);
    const result = await this.client().core.executeTransaction({ transaction: bytes, signatures: [signed.signature] });
    if (result.$kind !== 'Transaction' || result.Transaction.digest !== prepared.transactionDigest) throw Error('WALRUS_TRANSACTION_FAILED_OR_MISMATCH');
    return { transactionDigest: prepared.transactionDigest };
  }

  async verify(request: Omit<ChainRequest, 'operationId'|'ceiling'>, digest: string) {
    const prepared = this.pending.get(digest);
    if (!prepared || JSON.stringify(prepared.request.blobs) !== JSON.stringify(request.blobs) || prepared.request.kind !== request.kind || JSON.stringify(prepared.request.quote) !== JSON.stringify(request.quote)) throw Error('WALRUS_PREPARED_TRANSACTION_REQUIRED');
    return this.verifyPrepared(prepared, digest);
  }

  async verifyPrepared(prepared: PreparedLifecycleTransaction, digest: string) {
    if (digest !== prepared.transactionDigest || await Transaction.from(Buffer.from(prepared.transactionBase64, 'base64')).getDigest() !== digest) throw Error('WALRUS_TRANSACTION_DIGEST_MISMATCH');
    const client = this.client();
    const result = await client.core.waitForTransaction({ digest, include: { effects: true, transaction: true, balanceChanges: true } });
    if (result.$kind !== 'Transaction') throw Error('WALRUS_TRANSACTION_FAILED');
    const tx = result.Transaction;
    if (!tx.status.success || !tx.effects.status.success || tx.digest !== digest || tx.effects.transactionDigest !== digest || !tx.transaction.sender || !sameAddress(tx.transaction.sender, prepared.sender)) throw Error('WALRUS_CHAIN_EFFECTS_INVALID');
    const objects = [];
    for (const blob of prepared.request.blobs) {
      const effects = tx.effects.changedObjects.filter(o => id(o.objectId) === id(blob.objectId));
      if (effects.length !== 1 || effects[0].inputState !== 'Exists' || effects[0].inputOwner?.$kind !== 'AddressOwner' || !sameAddress(effects[0].inputOwner.AddressOwner, prepared.sender)) throw Error('WALRUS_TARGET_EFFECT_MISSING');
      const effect = effects[0];
      if (prepared.request.kind === 'delete') {
        if (effect.idOperation !== 'Deleted' || effect.outputState !== 'DoesNotExist') throw Error('WALRUS_DELETE_NOT_PROVEN');
        objects.push({ objectId: blob.objectId, blobId: blob.blobId, deleted: true });
      } else {
        const [actual, { object }] = await Promise.all([client.walrus.getBlobObject(blob.objectId), client.core.getObject({ objectId: blob.objectId, include: { previousTransaction: true } })]);
        const endEpoch = blob.endEpoch + prepared.request.quote!.epochs;
        if (effect.outputState !== 'ObjectWrite' || canonicalBlobId(actual.blob_id) !== blob.blobId || actual.storage.end_epoch !== endEpoch || object.previousTransaction !== digest || object.version !== effect.outputVersion || object.digest !== effect.outputDigest) throw Error('WALRUS_RENEW_NOT_PROVEN');
        objects.push({ objectId: blob.objectId, blobId: blob.blobId, endEpoch });
      }
    }
    return { transactionDigest: digest, network: 'mainnet', objects };
  }
}

import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { blobIdFromInt } from '@mysten/walrus';
import { WalrusChainProvider, type WalrusChainClient, type PreparedLifecycleTransaction } from '../src/memory/walrus-chain.js';
const owner = normalizeSuiAddress('0x1'), objectId = normalizeSuiAddress('0x2');
const ref = { objectId, blobId: blobIdFromInt('9'), owner, deletable: true, endEpoch: 20, currentEpoch: 12, network: 'mainnet' };
function fixture() {
  const blob = { id: objectId, blob_id: '9', deletable: true, storage: { end_epoch: 20, storage_size: '1048577' } };
  const object = { objectId, owner: { $kind: 'AddressOwner', AddressOwner: owner } };
  const client = { walrus: { getBlobObject: vi.fn(async () => blob), systemState: vi.fn(async () => ({ committee: { epoch: 12 }, storage_price_per_unit_size: '17' })), getBlobType: vi.fn(async () => '0xa::blob::Blob') }, core: { getObject: vi.fn(async () => ({ object })), listOwnedObjects: vi.fn(async () => ({ objects: [{ objectId }], hasNextPage: false, cursor: null })), waitForTransaction: vi.fn() } };
  const provider = new WalrusChainProvider({ clientFactory: () => client as unknown as WalrusChainClient });
  return { provider, client, blob, object };
}
async function prepared(): Promise<PreparedLifecycleTransaction> {
  const tx = new Transaction(); tx.setSender(owner); tx.setGasOwner(owner); tx.setGasPrice(1000); tx.setGasBudget(1000000);
  tx.setGasPayment([{ objectId: normalizeSuiAddress('0x3'), version: '1', digest: '11111111111111111111111111111111' }]);
  const bytes = await tx.build();
  return { transactionBase64: Buffer.from(bytes).toString('base64'), transactionDigest: await Transaction.from(bytes).getDigest(), sender: owner, request: { operationId: 'op', kind: 'delete', blobs: [ref] } };
}
describe('Mainnet Walrus lifecycle', () => {
  it('resolves only owned blob objects and uses Walrus committee epoch', async () => {
    const { provider, client } = fixture();
    expect(await provider.resolveOwnedBlob(ref.blobId, owner)).toEqual(ref);
    expect(client.core.listOwnedObjects).toHaveBeenCalledWith(expect.objectContaining({ owner, type: '0xa::blob::Blob' }));
  });
  it('rejects duplicate blob registrations rather than selecting an arbitrary owned object', async () => {
    const { provider, client } = fixture();
    client.core.listOwnedObjects.mockResolvedValue({ objects: [{ objectId }, { objectId: '0x8' }], hasNextPage: false, cursor: null });
    await expect(provider.resolveOwnedBlob(ref.blobId, owner)).rejects.toThrow('AMBIGUOUS');
  });
  it('quotes encoded size rounded up to MiB, storage only, in FROST', async () => {
    const { provider } = fixture();
    expect(await provider.quote([ref], 3)).toMatchObject({ amount: '102', epochs: 3, currency: 'WAL' });
    await expect(provider.quote([ref], 0)).rejects.toThrow('EPOCHS');
  });
  it('rejects a stale blob before quoting and does not authorize a delegate without an owner signer', async () => {
    const { provider, blob } = fixture(); blob.storage.end_epoch = 21;
    await expect(provider.quote([ref], 3)).rejects.toThrow('STALE');
    expect(await provider.authorized(owner, objectId, 'delete')).toBe(false);
  });
  it('rejects wrong digest without querying chain and requires exact deleted target effects', async () => {
    const { provider, client } = fixture(), expected = await prepared(), digest = expected.transactionDigest;
    await expect(provider.verifyPrepared(expected, 'wrong')).rejects.toThrow('DIGEST_MISMATCH');
    expect(client.core.waitForTransaction).not.toHaveBeenCalled();
    const effect = { objectId, inputState: 'Exists', inputOwner: { $kind: 'AddressOwner', AddressOwner: owner }, idOperation: 'Deleted', outputState: 'DoesNotExist' };
    const chainTx = { digest, status: { success: true }, transaction: { sender: owner }, effects: { transactionDigest: digest, status: { success: true }, changedObjects: [effect] } };
    client.core.waitForTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: chainTx });
    expect(await provider.verifyPrepared(expected, digest)).toMatchObject({ transactionDigest: digest, objects: [{ objectId, blobId: ref.blobId, deleted: true }] });
    effect.idOperation = 'None';
    await expect(provider.verifyPrepared(expected, digest)).rejects.toThrow('DELETE_NOT_PROVEN');
  });
  it('rejects failed chain effects and owner substitution', async () => {
    const { provider, client } = fixture(), expected = await prepared(), digest = expected.transactionDigest;
    client.core.waitForTransaction.mockResolvedValue({ $kind: 'FailedTransaction' });
    await expect(provider.verifyPrepared(expected, digest)).rejects.toThrow('TRANSACTION_FAILED');
    client.core.waitForTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: { digest, status: { success: true }, transaction: { sender: owner }, effects: { transactionDigest: digest, status: { success: true }, changedObjects: [{ objectId, inputState: 'Exists', inputOwner: { $kind: 'AddressOwner', AddressOwner: '0x9' }, idOperation: 'Deleted', outputState: 'DoesNotExist' }] } } });
    await expect(provider.verifyPrepared(expected, digest)).rejects.toThrow('TARGET_EFFECT_MISSING');
  });
  it('requires the exact renewal end epoch and transaction output version', async () => {
    const { provider, client, blob, object } = fixture(), expected = await prepared(), digest = expected.transactionDigest;
    expected.request.kind = 'renew'; expected.request.quote = { amount: '102', currency: 'WAL', epochs: 3, expiresAt: new Date(Date.now() + 60000).toISOString() };
    Object.assign(object, { previousTransaction: digest, version: '7', digest: 'output' }); blob.storage.end_epoch = 23;
    const effect = { objectId, inputState: 'Exists', inputOwner: { $kind: 'AddressOwner', AddressOwner: owner }, idOperation: 'None', outputState: 'ObjectWrite', outputVersion: '7', outputDigest: 'output' };
    client.core.waitForTransaction.mockResolvedValue({ $kind: 'Transaction', Transaction: { digest, status: { success: true }, transaction: { sender: owner }, effects: { transactionDigest: digest, status: { success: true }, changedObjects: [effect] } } });
    expect(await provider.verifyPrepared(expected, digest)).toMatchObject({ objects: [{ objectId, blobId: ref.blobId, endEpoch: 23 }] });
    blob.storage.end_epoch = 24;
    await expect(provider.verifyPrepared(expected, digest)).rejects.toThrow('RENEW_NOT_PROVEN');
    blob.storage.end_epoch = 23; Object.assign(object, { previousTransaction: 'a-later-transaction' });
    await expect(provider.verifyPrepared(expected, digest)).rejects.toThrow('RENEW_NOT_PROVEN');
  });
  it('rejects changed ownership and excessive budgets before building or submitting', async () => {
    const { provider } = fixture();
    await expect(provider.prepare({ operationId: 'op', kind: 'delete', blobs: [ref] }, '0x9')).rejects.toThrow('AUTHORITY_CHANGED');
    await expect(provider.prepare({ operationId: 'op', kind: 'renew', blobs: [ref], quote: { amount: '102', currency: 'WAL', epochs: 3, expiresAt: new Date(Date.now() + 60000).toISOString() }, ceiling: '101' }, owner)).rejects.toThrow('BUDGET');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import type { Alert, Pool, Position } from '../src/types.js';

test('persists pool snapshots and deduplicates alerts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'defi-tool-'));
  const store = new Store(join(directory, 'state.db'));
  const pool: Pool = {
    id: 'pool', chainId: 1, protocol: 'v3',
    token0: { address: 'a', symbol: 'A', decimals: 18 },
    token1: { address: 'b', symbol: 'B', decimals: 18 },
    source: 'uniswap-api', observedAt: new Date().toISOString(),
  };
  store.savePools([pool]);
  const alert: Alert = { fingerprint: 'one', type: 'near_boundary', wallet: 'wallet', positionId: 'position', message: 'test', createdAt: new Date().toISOString(), acknowledged: false };
  store.saveAlert(alert);
  store.saveAlert(alert);
  assert.equal(store.hasAlert('one'), true);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test('RPC NFT IDs on different chains and protocols do not overwrite each other', () => {
  const store = new Store(':memory:');
  try {
    const position: Position = { id: '42', wallet: '0xwallet', poolId: '0xpool', chainId: 1, protocol: 'v3', source: 'rpc' };
    store.savePositions([position, { ...position, chainId: 8453 }, { ...position, protocol: 'v4' }]);
    const result = store.db.prepare('SELECT COUNT(*) AS total FROM positions').get();
    assert.equal(result?.total, 3);
  } finally { store.close(); }
});

test('remembers pool identities without erasing a known creation time', () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-identity-'));
  const store = new Store(join(directory, 'state.db'));
  try {
    store.savePoolIdentity('1:v4:uuid', '0xabc', '2025-01-30T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    store.savePoolIdentity('1:v4:uuid', undefined, undefined, '2026-02-01T00:00:00.000Z');
    store.savePoolIdentity('1:v4:missing', undefined, undefined, '2026-02-01T00:00:00.000Z');
    const found = store.poolIdentities(['1:v4:uuid', '1:v4:missing', '1:v4:never']);
    assert.deepEqual(found.get('1:v4:uuid'), { address: '0xabc', createdAt: '2025-01-30T00:00:00.000Z', checkedAt: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual(found.get('1:v4:missing'), { address: undefined, createdAt: undefined, checkedAt: '2026-02-01T00:00:00.000Z' });
    assert.equal(found.has('1:v4:never'), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('saves, lists, renames, moves and deletes wallets with unique names and addresses', () => {
  const store = new Store(':memory:');
  try {
    const address = '0x0000000000000000000000000000000000000001';
    assert.equal(store.nextWalletName(), 'wallet0');
    store.addWallet({ name: store.nextWalletName(), address, chainId: 1 }, '2026-10-29T00:00:00.000Z');
    store.addWallet({ name: 'Main', address, chainId: 8453 });
    assert.equal(store.nextWalletName(), 'wallet1');
    assert.throws(() => store.addWallet({ name: 'MAIN', address: '0x0000000000000000000000000000000000000002', chainId: 1 }), /named "Main" already exists/);
    assert.throws(() => store.addWallet({ name: 'other', address, chainId: 1 }), /already saved for that network as "wallet0"/);
    assert.equal(store.wallet('main')?.chainId, 8453);

    const renamed = store.updateWallet('main', { name: 'trading' }, '2026-10-29T01:00:00.000Z');
    assert.deepEqual([renamed.name, renamed.chainId, renamed.updatedAt], ['trading', 8453, '2026-10-29T01:00:00.000Z']);
    assert.throws(() => store.updateWallet('trading', { chainId: 1 }), /already saved for that network as "wallet0"/);
    assert.equal(store.updateWallet('trading', { chainId: 42161 }).chainId, 42161);
    assert.throws(() => store.updateWallet('missing', { name: 'x' }), /No saved wallet named "missing"/);

    assert.deepEqual(store.wallets().map((item) => [item.name, item.chainId]), [['wallet0', 1], ['trading', 42161]]);

    assert.equal(store.deleteWallet('WALLET0'), true);
    assert.equal(store.deleteWallet('wallet0'), false);
    assert.deepEqual(store.wallets().map((item) => item.name), ['trading']);
  } finally { store.close(); }
});

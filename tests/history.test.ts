import test from 'node:test';
import assert from 'node:assert/strict';
import { AlchemyClient } from '../src/providers/alchemy.js';
import { RevertClient } from '../src/providers/revert.js';
import { walletHistory } from '../src/history.js';
import { activityDetails } from '../src/output.js';
import { closedArbitrum, WALLET } from './fixtures/revert.js';

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const SCAM = '0x00000000000000000000000000000000000005ca';
const ROUTER = '0x000000000000000000000000000000000000r0ut'.replace('r0ut', 'abcd');
const FRIEND = '0x00000000000000000000000000000000000f00d5';
const SINCE = 1_791_000_000;
const T = 1_793_100_000; // Inside the window.
// The Revert position's transactions, given hashes: deposit, fee claim, withdrawal.
const [DEPOSIT, CLAIM, WITHDRAW] = ['0xd1', '0xc1', '0xe1'];
const hashes: Record<number, string> = { 1791484414: DEPOSIT, 1793221568: CLAIM, 1793258847: WITHDRAW };
const revertRow = { ...closedArbitrum, cash_flows: closedArbitrum.cash_flows.map((flow) => ({ ...flow, tx_hash: hashes[flow.timestamp] })) };

const transfer = (hash: string, from: string, to: string, asset: string, contract: string | null, raw: bigint, decimals: number, timestamp: number) => ({
  hash, from, to, asset, category: contract ? 'erc20' : 'external', value: Number(raw) / 10 ** decimals,
  rawContract: { value: `0x${raw.toString(16)}`, address: contract, decimal: `0x${decimals.toString(16)}` },
  metadata: { blockTimestamp: new Date(timestamp * 1000).toISOString() },
});
const OUT = [
  transfer('0xs1', WALLET, ROUTER, 'USDC', USDC, 100_000_000n, 6, T),
  transfer('0xw1', WALLET, WETH, 'ETH', null, 10n ** 16n, 18, T - 100),
  transfer(DEPOSIT, WALLET, '0x00000000000000000000000000000000000000aa', 'USDC', USDC, 33_078_043n, 6, 1_791_484_414), // Also in Revert: Revert's entry wins.
];
const IN = [
  transfer('0xs1', ROUTER, WALLET, 'WETH', WETH, 4n * 10n ** 16n, 18, T),
  transfer('0xw1', WETH, WALLET, 'WETH', WETH, 10n ** 16n, 18, T - 100),
  transfer('0xr1', FRIEND, WALLET, 'USDC', USDC, 50_000_000n, 6, T - 200),
  transfer('0xsp', FRIEND, WALLET, 'FREE', SCAM, 10n ** 21n, 18, T - 300),
  transfer('0xold', FRIEND, WALLET, 'USDC', USDC, 1_000_000n, 6, SINCE - 10),
];

function fetcher(requests: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('http://revert.test')) return Response.json(url.includes('uniswapv3') ? { success: true, data: [revertRow] } : { success: true, data: [] });
    if (url.startsWith('http://alchemy.test/arb-mainnet')) {
      const body = JSON.parse(String(init!.body));
      if (Array.isArray(body)) {
        // Receipts: the wallet sent the swap and the wrap; the friend sent the USDC.
        return Response.json(body.map((call: { id: number; params: [string] }) => ({ id: call.id, result: {
          from: call.params[0] === '0xr1' ? FRIEND : WALLET, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', l1Fee: '0x0', status: '0x1',
        } })));
      }
      return Response.json({ result: { transfers: body.params[0].fromAddress ? OUT : IN } });
    }
    if (url.startsWith('http://prices.test/prices/current/')) return Response.json({ coins: {} }); // The airdropped token has no price.
    if (url.startsWith('http://prices.test/batchHistorical')) {
      const coins = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('coins')!)) as Record<string, number[]>;
      const price = (key: string) => key.endsWith(USDC) ? 1 : key.endsWith(WETH) || key === 'coingecko:ethereum' ? 2500 : undefined;
      return Response.json({ coins: Object.fromEntries(Object.entries(coins).filter(([key]) => price(key)).map(([key, times]) => [key, { prices: times.map((timestamp) => ({ timestamp: timestamp + 30, price: price(key) })) }])) });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const clients = (requests: string[], alchemy = true) => ({
  revert: new RevertClient({ endpoint: 'http://revert.test', fetcher: fetcher(requests), retryDelayMs: 0 }),
  alchemy: alchemy ? new AlchemyClient({ apiKey: 'k', endpoint: 'http://alchemy.test', fetcher: fetcher(requests), retryDelayMs: 0 }) : undefined,
});
const request = { address: WALLET, chains: [42161] as const, since: SINCE, top: 50, includeSpam: false, pricesUrl: 'http://prices.test', fetcher: fetcher([]) };

test('merges liquidity activity with classified swaps, wraps and receives, valued at the time and with gas', async () => {
  const requests: string[] = [];
  const messages: string[] = [];
  const result = await walletHistory({ ...request, chains: [42161] }, clients(requests), (message) => messages.push(message));
  assert.deepEqual(messages, []);
  assert.deepEqual(result.sources, ['Revert Finance', 'Alchemy']);
  assert.deepEqual(result.activities.map((activity) => [activity.hash, activity.kind]), [
    [WITHDRAW, 'remove-liquidity'], [CLAIM, 'collect-fees'], ['0xs1', 'swap'], ['0xw1', 'wrap'], ['0xr1', 'receive'], [DEPOSIT, 'add-liquidity'],
  ]);
  const byHash = Object.fromEntries(result.activities.map((activity) => [activity.hash, activity]));
  // Swap: 100 USDC out, 0.04 WETH in at $2,500: $100 sent, $100 received.
  assert.equal(activityDetails(byHash['0xs1']!), '100.0000 USDC → 0.04000 WETH');
  assert.equal(byHash['0xs1']!.received[0]!.valueUsd, 100);
  // Gas: 21,000 × 1 gwei = 0.000021 ETH at $2,500, only for transactions the wallet sent.
  assert.ok(Math.abs(byHash['0xs1']!.gasUsd! - 0.0525) < 1e-9);
  assert.equal(byHash['0xr1']!.gasUsd, undefined);
  assert.equal(byHash['0xr1']!.counterparty, FRIEND);
  assert.match(activityDetails(byHash['0xr1']!), /50\.0000 USDC ← 0x0000…00d5/);
  // The LP deposit comes from Revert (exact, priced at the time) and is not duplicated from the transfer.
  assert.equal(byHash[DEPOSIT]!.source, 'revert');
  assert.equal(byHash[DEPOSIT]!.pool, 'WETH/USDC 0.05% v3');
  assert.match(activityDetails(byHash[DEPOSIT]!), /0\.01854 WETH \+ 33\.0780 USDC → WETH\/USDC 0\.05% v3 #5723933/);
  assert.equal(byHash[WITHDRAW]!.explorerUrl, `https://arbiscan.io/tx/${WITHDRAW}`);
  // Spam is hidden and counted; the old transfer is outside the window.
  assert.equal(result.spamHidden, 1);
  assert.ok(!result.activities.some((activity) => activity.hash === '0xold'));
  assert.equal(result.summary.byKind.swap, 1);
  assert.ok(Math.abs(result.summary.swapCostUsd) < 1e-9);
  assert.ok(Math.abs(result.summary.feesCollectedUsd - 2.793) < 0.01);
});

test('filters by kind, limits rows, shows spam on request, and works without an Alchemy key', async () => {
  const swaps = await walletHistory({ ...request, chains: [42161], kinds: ['swap', 'receive'], top: 1, includeSpam: true }, clients([]), () => {});
  assert.equal(swaps.total, 3); // Swap, receive, and the spam receive.
  assert.deepEqual(swaps.activities.map((activity) => activity.hash), ['0xs1']);
  const spam = await walletHistory({ ...request, chains: [42161], kinds: ['receive'], includeSpam: true }, clients([]), () => {});
  assert.equal(spam.activities.find((activity) => activity.hash === '0xsp')?.spam, true);

  const requests: string[] = [];
  const lpOnly = await walletHistory({ ...request, chains: [42161], fetcher: fetcher(requests) }, clients(requests, false), () => {});
  assert.deepEqual(lpOnly.sources, ['Revert Finance']);
  assert.deepEqual(lpOnly.activities.map((activity) => activity.kind), ['remove-liquidity', 'collect-fees', 'add-liquidity']);
  assert.ok(!requests.some((url) => url.includes('alchemy')));
  // Revert already prices liquidity flows and gas: no price lookups are needed.
  assert.ok(!requests.some((url) => url.includes('prices.test')));
});

test('reports a failing source without failing, and names a bad key', async () => {
  const denied = (async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Must be authenticated!' } })) as unknown as typeof fetch;
  const messages: string[] = [];
  const result = await walletHistory({ ...request, chains: [42161] }, { revert: clients([]).revert, alchemy: new AlchemyClient({ apiKey: 'bad', endpoint: 'http://alchemy.test', fetcher: denied, retryDelayMs: 0 }) }, (message) => messages.push(message));
  assert.equal(result.activities.length, 3);
  assert.match(messages.join('\n'), /Arbitrum: swaps and transfers are unavailable: Alchemy: Must be authenticated!\. Check ALCHEMY_API_KEY/);
});

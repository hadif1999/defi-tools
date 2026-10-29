import test from 'node:test';
import assert from 'node:assert/strict';
import { hooklessV4PoolId, poolAddress } from '../src/providers/pool-address.js';
import { DexScreenerClient } from '../src/providers/dexscreener.js';
import { formatAge, formatCount } from '../src/output.js';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

test('derives real Uniswap v2 and v3 pool addresses from tokens and fee', () => {
  assert.equal(poolAddress(1, 'v3', USDC, WETH, 500), '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  assert.equal(poolAddress(1, 'v3', WETH, USDC, 500), '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'); // Token order does not matter.
  assert.equal(poolAddress(1, 'v2', USDC, WETH), '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
  assert.equal(poolAddress(8453, 'v3', '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 3000), '0x6c561b446416e1a00e8e93e221854d6ea4171372');
  // Robinhood Chain USDG/WETH 0.01%, as listed by GeckoTerminal and DexScreener.
  assert.equal(poolAddress(4663, 'v3', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 100), '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca');
  assert.equal(poolAddress(1, 'v3', USDC, WETH), undefined); // v3 needs a fee tier.
  assert.equal(poolAddress(1, 'v4', USDC, WETH, 500), undefined);
  assert.equal(poolAddress(1, 'v2', 'not-an-address', WETH), undefined);
  assert.equal(poolAddress(1, 'v2', WETH, WETH), undefined);
});

test('guesses hookless v4 pool IDs only for standard fee tiers', () => {
  const id = hooklessV4PoolId('0x0000000000000000000000000000000000000000', USDC, 3000);
  assert.match(id!, /^0x[0-9a-f]{64}$/);
  assert.equal(hooklessV4PoolId(USDC, '0x0000000000000000000000000000000000000000', 3000), id);
  assert.notEqual(hooklessV4PoolId('0x0000000000000000000000000000000000000000', USDC, 500), id);
  assert.equal(hooklessV4PoolId(USDC, WETH, 3500), undefined);
  assert.equal(hooklessV4PoolId(USDC, WETH, undefined), undefined);
});

const pair = (pairAddress: string, extra: Record<string, unknown> = {}) => ({
  pairAddress, dexId: 'uniswap', labels: ['v3'], pairCreatedAt: Date.parse('2021-05-05T21:42:11Z'),
  txns: { h24: { buys: 2360, sells: 2093 } }, liquidity: { usd: 1_000_000 }, ...extra,
});

test('reads age and 24h swaps in batches of 30 and skips unknown pools', async () => {
  const urls: string[] = [];
  const client = new DexScreenerClient({ retryDelayMs: 0, fetcher: async (url) => {
    urls.push(String(url));
    const addresses = String(url).split('/').at(-1)!.split(',');
    return Response.json({ pairs: urls.length === 1 ? addresses.slice(0, 2).map((address) => pair(address.toUpperCase())) : null });
  } });
  const addresses = Array.from({ length: 31 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const details = await client.details(8453, addresses);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /\/latest\/dex\/pairs\/base\//);
  assert.equal(urls[0]!.split(',').length, 30);
  assert.equal(details.size, 2);
  assert.deepEqual(details.get(addresses[0]!), { address: addresses[0], createdAt: '2021-05-05T21:42:11.000Z', txCount24h: 4453, liquidityUsd: 1_000_000 });
  await assert.rejects(new DexScreenerClient({ retryDelayMs: 0, fetcher: async () => new Response('', { status: 429 }) }).details(1, addresses), /DexScreener.*429/);
});

test('matches a v4 pool by tokens and the closest TVL within 10%', async () => {
  const urls: string[] = [];
  const v4 = (address: string, usd: number, quote = USDC) => pair(address, { labels: ['v4'], liquidity: { usd }, baseToken: { address: '0x0000000000000000000000000000000000000000' }, quoteToken: { address: quote.toUpperCase() } });
  const client = new DexScreenerClient({ retryDelayMs: 0, fetcher: async (url) => {
    urls.push(String(url));
    return Response.json([v4('0xaa', 30_000_000), v4('0xbb', 41_000_000), v4('0xcc', 41_400_000, WETH), pair('0xdd', { liquidity: { usd: 41_500_000 } })]);
  } });
  const native = '0x0000000000000000000000000000000000000000';
  assert.equal((await client.findByTokens(1, 'Uniswap', 'v4', native, USDC, 41_500_000))?.address, '0xbb');
  assert.equal(await client.findByTokens(1, 'Uniswap', 'v4', native, USDC, 60_000_000), undefined); // Nothing within 10%.
  assert.equal(await client.findByTokens(1, 'Uniswap', 'v4', native, USDC, undefined), undefined);
  assert.equal(urls.length, 1); // The token's pair list is fetched once and reused.
  assert.match(urls[0]!, new RegExp(`/token-pairs/v1/ethereum/${USDC}$`));
});

test('formats age and counts compactly', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  assert.equal(formatAge('2026-10-27T23:30:00Z', now), '<1h');
  assert.equal(formatAge('2026-10-27T18:00:00Z', now), '6h');
  assert.equal(formatAge('2026-10-10T00:00:00Z', now), '18d');
  assert.equal(formatAge('2025-12-01T00:00:00Z', now), '10mo');
  assert.equal(formatAge('2021-05-05T00:00:00Z', now), '5.5y');
  assert.equal(formatAge(undefined, now), '—');
  assert.equal(formatAge('not a date', now), '—');
  assert.equal(formatCount(842), '842');
  assert.equal(formatCount(15_410), '15.4K');
  assert.equal(formatCount(undefined), '—');
});

test('matches a Raydium pool by its non-quote token, pool type and TVL, keeping Solana address case', async () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const BOME = 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82';
  const urls: string[] = [];
  const ray = (address: string, labels: string[], usd: number) => pair(address, { dexId: 'raydium', labels, liquidity: { usd }, baseToken: { address: BOME }, quoteToken: { address: SOL } });
  const client = new DexScreenerClient({ retryDelayMs: 0, fetcher: async (url) => {
    urls.push(String(url));
    return Response.json([ray('ClmmPoolAddr', ['CLMM'], 6_000_000), ray('AmmPoolAddr', [], 6_100_000), pair('Other', { dexId: 'orca', liquidity: { usd: 6_000_000 } })]);
  } });
  assert.equal((await client.findByTokens(501, 'Raydium', 'clmm', SOL, BOME, 6_000_000))?.address, 'ClmmPoolAddr');
  assert.equal((await client.findByTokens(501, 'Raydium', 'amm', BOME, SOL, 6_000_000))?.address, 'AmmPoolAddr');
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, new RegExp(`/token-pairs/v1/solana/${BOME}$`)); // Not SOL, which pairs with thousands of tokens.
});

test('matches PancakeSwap, Aerodrome and Curve pools by dexId, trying the second token when the first has no match', async () => {
  const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  const urls: string[] = [];
  const cake = (address: string, labels: string[] | undefined, usd: number) => pair(address, { dexId: 'pancakeswap', labels, liquidity: { usd }, baseToken: { address: CAKE }, quoteToken: { address: WBNB } });
  const client = new DexScreenerClient({ retryDelayMs: 0, fetcher: async (url) => {
    urls.push(String(url));
    // CAKE's listing lacks the pool; WBNB's has a v3 pool, an unlabeled one, and another exchange's at the same TVL.
    return Response.json(String(url).endsWith(CAKE) ? [] : [cake('0xv3', ['v3'], 5_000_000), cake('0xplain', undefined, 5_050_000), pair('0xother', { dexId: 'biswap', liquidity: { usd: 5_000_000 }, baseToken: { address: CAKE }, quoteToken: { address: WBNB } })]);
  } });
  assert.equal((await client.findByTokens(56, 'PancakeSwap', 'v2', CAKE, WBNB, 5_000_000))?.address, '0xplain'); // The v3-labelled pool is not v2.
  assert.equal((await client.findByTokens(56, 'PancakeSwap', 'v3', CAKE, WBNB, 5_000_000))?.address, '0xv3');
  assert.equal(await client.findByTokens(56, 'Curve', 'amm', CAKE, WBNB, 5_000_000), undefined);
  assert.equal(urls.length, 2); // Each token's listing is fetched once.
});

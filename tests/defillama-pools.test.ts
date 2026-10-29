import test from 'node:test';
import assert from 'node:assert/strict';
import { DefiLlamaPoolsClient } from '../src/providers/defillama-pools.js';

const row = (overrides: Record<string, unknown>) => ({
  pool: 'id', chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', tvlUsd: 1_000_000, apyBase: 12.5,
  volumeUsd1d: 200_000, volumeUsd7d: 1_400_000, poolMeta: '0.05%',
  underlyingTokens: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'], ...overrides,
});
const fixture = { status: 'success', data: [
  row({ pool: 'v3-small', tvlUsd: 1_000_000 }),
  row({ pool: 'v2-big', project: 'uniswap-v2', symbol: 'WISE-WETH', tvlUsd: 9_000_000, poolMeta: null, volumeUsd1d: 500 }),
  row({ pool: 'v4-tiny-fee', project: 'uniswap-v4', symbol: 'PYUSD-USDS', tvlUsd: 5_000_000, poolMeta: '0.00%', volumeUsd7d: null }),
  row({ pool: 'v4-dynamic', project: 'uniswap-v4', tvlUsd: 2_000_000, poolMeta: 'Dynamic fee (hook)', volumeUsd1d: 9_000_000 }),
  row({ pool: 'base-pool', chain: 'Base', tvlUsd: 50_000_000 }),
  row({ pool: 'bnb-pool', chain: 'BSC', project: 'uniswap-v4', tvlUsd: 3_000_000 }),
  row({ pool: 'not-uniswap', project: 'sushiswap', tvlUsd: 99_000_000 }),
  row({ pool: 'ray-clmm', chain: 'Solana', project: 'raydium-amm', symbol: 'WSOL-USDC', poolMeta: 'Concentrated - 0.04%', tvlUsd: 8_000_000,
    underlyingTokens: ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] }),
  row({ pool: 'ray-amm', chain: 'Solana', project: 'raydium-amm', symbol: 'BOME-WSOL', poolMeta: 'Standard - 0.25%', tvlUsd: 6_000_000, volumeUsd1d: 400_000 }),
  row({ pool: 'bad-tvl', tvlUsd: 'not a number' }),
  { project: 'uniswap-v3', chain: 'Ethereum' },
] };

function client(responses: Array<Response | Error>) {
  let calls = 0;
  const instance = new DefiLlamaPoolsClient({ retryDelayMs: 0, fetcher: async (url, init) => {
    calls += 1;
    assert.match(String(url), /\/pools$/);
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    const next = responses.shift() ?? Response.json(fixture);
    if (next instanceof Error) throw next;
    return next;
  } });
  return { instance, calls: () => calls };
}

test('lists every Uniswap version on a chain by TVL, like the Explore page', async () => {
  const { instance, calls } = client([]);
  const pools = await instance.listPools(1, ['v2', 'v3', 'v4']);
  assert.deepEqual(pools.map((pool) => pool.id), ['v2-big', 'v4-tiny-fee', 'v4-dynamic', 'v3-small']);
  const [v2, tiny, dynamic, v3] = pools;
  assert.equal(v2?.protocol, 'v2');
  assert.equal(v2?.feeTier, 3000);
  assert.equal(v2?.name, 'WISE/WETH');
  assert.equal(tiny?.feeTier, undefined);
  assert.equal(tiny?.feeLabel, '<0.01%');
  assert.equal(tiny?.volume7dUsd, undefined);
  assert.equal(dynamic?.feeLabel, 'dynamic');
  assert.equal(dynamic?.fees24hUsd, undefined);
  assert.equal(v3?.feeTier, 500);
  assert.equal(v3?.fees24hUsd, 100);
  assert.equal(v3?.aprPct, 12.5);
  assert.equal(v3?.volume7dUsd, 1_400_000);
  assert.equal(v3?.token1.symbol, 'WETH');
  assert.equal(v3?.source, 'defillama');
  // One download serves every chain in the run.
  assert.deepEqual((await instance.listPools(8453, ['v2', 'v3', 'v4'])).map((pool) => pool.id), ['base-pool']);
  assert.deepEqual((await instance.listPools(56, ['v2', 'v3', 'v4'])).map((pool) => pool.id), ['bnb-pool']);
  await assert.rejects(instance.listPools(4663, ['v3']), /DefiLlama has no Uniswap pools on Robinhood Chain/);
  assert.equal(calls(), 1);
});

test('filters by version, sorts by the chosen metric and applies filters before the limit', async () => {
  const { instance } = client([]);
  assert.deepEqual((await instance.listPools(1, ['v4'])).map((pool) => pool.id), ['v4-tiny-fee', 'v4-dynamic']);
  assert.deepEqual((await instance.listPools(1, ['v2', 'v3', 'v4'], 2, ['volume'])).map((pool) => pool.id), ['v4-dynamic', 'v4-tiny-fee']);
  assert.deepEqual((await instance.listPools(1, ['v2', 'v3', 'v4'], 1, ['tvl'], (pool) => pool.protocol === 'v3')).map((pool) => pool.id), ['v3-small']);
  assert.deepEqual((await instance.listPools(1, ['v2', 'v3'])).map((pool) => pool.id), ['v2-big', 'v3-small']);
  assert.deepEqual(await instance.listPools(10, ['v2', 'v3', 'v4']), []);
});

test('retries one transient failure and explains persistent ones', async () => {
  const retried = client([new TypeError('fetch failed')]);
  assert.equal((await retried.instance.listPools(1, ['v2', 'v3', 'v4'])).length, 4);
  assert.equal(retried.calls(), 2);

  for (const [responses, message] of [
    [[new TypeError('fetch failed'), new TypeError('fetch failed')], /Could not reach DefiLlama/],
    [[new Response('slow down', { status: 429 })], /HTTP 429.*rate limit/],
    [[new Response('down', { status: 503 }), new Response('down', { status: 503 })], /HTTP 503/],
    [[new Response('<html>', { status: 200 })], /not valid JSON/],
    [[Response.json({ unexpected: true })], /unexpected response/],
  ] as const) {
    const failing = client([...responses]);
    await assert.rejects(failing.instance.listPools(1, ['v2', 'v3', 'v4']), message);
    // A failed download is not cached; the next call fetches again.
    assert.equal((await failing.instance.listPools(1, ['v2', 'v3', 'v4'])).length, 4);
  }
});

test('lists Raydium pools on Solana as CLMM or AMM with their fee', async () => {
  const { instance } = client([]);
  const [clmm, amm] = await instance.listPools(501, ['v2', 'v3', 'v4', 'clmm', 'amm']);
  assert.equal(clmm?.id, 'ray-clmm');
  assert.equal(clmm?.dex, 'Raydium');
  assert.equal(clmm?.protocol, 'clmm');
  assert.equal(clmm?.feeTier, 400);
  assert.equal(clmm?.name, 'WSOL/USDC');
  assert.equal(clmm?.address, undefined); // No EVM address to derive; DexScreener matches it by tokens.
  assert.equal(clmm?.token0.address, 'So11111111111111111111111111111111111111112'); // Solana addresses keep their case.
  assert.equal(amm?.protocol, 'amm');
  assert.equal(amm?.feeTier, 2500);
  assert.equal(amm?.fees24hUsd, 1000);
  assert.deepEqual((await instance.listPools(501, ['clmm'])).map((pool) => pool.id), ['ray-clmm']);
  assert.deepEqual(await instance.listPools(501, ['v3']), []);
  assert.ok((await instance.listPools(1, ['v2', 'v3', 'v4', 'clmm', 'amm'])).every((pool) => pool.dex === 'Uniswap'));
});

test('lists PancakeSwap, Aerodrome and Curve pools with their type, fee and tokens', async () => {
  const { instance } = client([Response.json({ data: [
    row({ pool: 'cake-v2', chain: 'BSC', project: 'pancakeswap-amm', symbol: 'CAKE-WBNB', poolMeta: null, tvlUsd: 9_000_000 }),
    row({ pool: 'cake-v3', chain: 'BSC', project: 'pancakeswap-amm-v3', symbol: 'USDT-WBNB', poolMeta: '0.01%', tvlUsd: 8_000_000 }),
    row({ pool: 'slipstream', chain: 'Base', project: 'aerodrome-slipstream', symbol: 'WETH-USDC', poolMeta: 'CL100 - 0.05%', tvlUsd: 7_000_000 }),
    row({ pool: 'aero-basic', chain: 'Base', project: 'aerodrome-v1', symbol: 'USDC-AERO', poolMeta: null, apyBase: null, tvlUsd: 6_000_000 }),
    row({ pool: '3pool', project: 'curve-dex', symbol: 'DAI-USDC-USDT', poolMeta: null, tvlUsd: 5_000_000,
      underlyingTokens: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003'] }),
    row({ pool: 'hyphen', project: 'pancakeswap-amm-v3', symbol: 'ERC20-USDC-USDT', tvlUsd: 4_000_000 }),
  ] })]);
  const [v2, v3] = await instance.listPools(56, ['v2', 'v3', 'v4', 'clmm', 'amm']);
  assert.deepEqual([v2?.dex, v2?.protocol, v2?.feeTier, v2?.address], ['PancakeSwap', 'v2', 2500, undefined]); // Only Uniswap addresses are derived.
  assert.deepEqual([v3?.protocol, v3?.feeTier], ['v3', 100]);
  const [slipstream, basic] = await instance.listPools(8453, ['clmm', 'amm']);
  assert.deepEqual([slipstream?.dex, slipstream?.protocol, slipstream?.feeTier, slipstream?.tickSpacing], ['Aerodrome', 'clmm', 500, 100]);
  assert.deepEqual([basic?.protocol, basic?.feeTier, basic?.aprPct], ['amm', undefined, undefined]);
  const [curve, hyphen] = await instance.listPools(1, ['amm', 'v3']);
  assert.deepEqual([curve?.dex, curve?.protocol, curve?.name, curve?.feeTier], ['Curve', 'amm', 'DAI/USDC/USDT', undefined]);
  assert.deepEqual(curve?.tokens?.map((token) => token.symbol), ['DAI', 'USDC', 'USDT']);
  assert.equal(curve?.tokens?.[2]?.address, '0x0000000000000000000000000000000000000003');
  // "ERC20-USDC-USDT" with two token addresses is two tokens, one of them hyphenated: the split is unknown, so it is kept whole.
  assert.deepEqual([hyphen?.name, hyphen?.tokens, hyphen?.token1.symbol], ['ERC20-USDC-USDT', undefined, '?']);
});

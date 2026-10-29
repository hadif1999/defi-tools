import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicPoolsClient } from '../src/providers/public-pools.js';

function page(address = '0x000000000000000000000000000000000000000a') {
  return { data: [{ id: `eth_${address}`, type: 'pool', attributes: {
    address, name: 'USDC / WETH 0.05%', reserve_in_usd: '1000000',
    volume_usd: { h24: '2000000' }, base_token_price_quote_token: '0.0004',
    price_change_percentage: { h24: '3.1' },
  }, relationships: {
    base_token: { data: { id: 'eth_0x0000000000000000000000000000000000000001' } },
    quote_token: { data: { id: 'eth_0x0000000000000000000000000000000000000002' } },
  } }], included: [
    { id: 'eth_0x0000000000000000000000000000000000000001', type: 'token', attributes: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6 } },
    { id: 'eth_0x0000000000000000000000000000000000000002', type: 'token', attributes: { address: '0x0000000000000000000000000000000000000002', symbol: 'WETH', decimals: 18 } },
  ] };
}

test('public pools use real REST paths, omit credentials and preserve honest metrics', async () => {
  const calls: string[] = [];
  const client = new PublicPoolsClient({ intervalMs: 0, fetcher: async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    return Response.json(page());
  } });
  const [pool] = await client.listPools(1, 'v3', 1);
  assert.match(calls[0]!, /networks\/eth\/dexes\/uniswap_v3\/pools/);
  assert.equal(pool?.source, 'geckoterminal');
  assert.equal(pool?.tvlUsd, 1_000_000);
  assert.equal(pool?.volume24hUsd, 2_000_000);
  assert.equal(pool?.feeTier, 500); // Parsed from the pool name "USDC / WETH 0.05%".
  assert.equal(pool?.fees24hUsd, 1_000);
  assert.equal(pool?.aprPct, 36.5); // $1,000 a day on $1M TVL.
  assert.equal(pool?.name, 'USDC/WETH');
  assert.equal(pool?.volatility24hPct, undefined); // One day's price change is not realized volatility.
  assert.equal(pool?.token0.symbol, 'USDC');
  await client.listPools(8453, 'v4', 1);
  assert.match(calls[1]!, /networks\/base\/dexes\/uniswap-v4-base\/pools/);
  await client.listPools(4663, 'v3', 1);
  assert.match(calls[2]!, /networks\/robinhood\/dexes\/uniswap-v3-robinhood\/pools/);
  await client.listPools(56, 'v4', 1);
  assert.match(calls[3]!, /networks\/bsc\/dexes\/uniswap-v4-bsc\/pools/);
});

test('public discovery paginates, deduplicates and never returns more than requested', async () => {
  let requests = 0;
  const client = new PublicPoolsClient({ intervalMs: 0, fetcher: async () => {
    requests += 1;
    if (requests === 1) return Response.json({ ...page(), data: Array.from({ length: 20 }, (_, i) => page(`0x${i.toString(16).padStart(40, '0')}`).data[0]) });
    return Response.json(page('0x0000000000000000000000000000000000000020'));
  } });
  assert.equal((await client.listPools(1, 'v3', 21)).length, 21);
  assert.equal(requests, 2);
});

test('public provider rejects malformed pages, invalid metrics and HTTP failures', async () => {
  for (const response of [Response.json({}), Response.json({ data: [{}] }), new Response('rate limited', { status: 429 }), new Response('down', { status: 503 })]) {
    const client = new PublicPoolsClient({ intervalMs: 0, fetcher: async () => response });
    await assert.rejects(client.listPools(1, 'v3', 1), /(GeckoTerminal|public pool)/i);
  }
  const fixture = page();
  fixture.data[0]!.attributes.reserve_in_usd = 'not a number';
  const client = new PublicPoolsClient({ intervalMs: 0, fetcher: async () => Response.json(fixture) });
  const [pool] = await client.listPools(1, 'v3', 1);
  assert.equal(pool?.tvlUsd, undefined);
});

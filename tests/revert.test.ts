import test from 'node:test';
import assert from 'node:assert/strict';
import { RevertClient } from '../src/providers/revert.js';
import { closedArbitrum, closedEthereum, NOW, openBase, WALLET } from './fixtures/revert.js';

const ALL = [1, 10, 56, 137, 8453, 42161] as const;
const near = (actual: number | undefined, expected: number, tolerance = 0.01) => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

function client(pages: Record<string, unknown[]>, urls: string[] = []) {
  return new RevertClient({ retryDelayMs: 0, now: () => NOW, fetcher: async (url) => {
    urls.push(String(url));
    const key = Object.keys(pages).find((prefix) => String(url).includes(prefix));
    return key ? Response.json(pages[key]!.shift()) : Response.json({ success: true, data: [], pagination: { next_cursor: null } });
  } });
}

test('maps open and closed positions, valuing deposits, withdrawals and fees when they happened', async () => {
  const urls: string[] = [];
  const revert = client({ uniswapv3: [{ success: true, data: [closedArbitrum, openBase, { ...openBase, nft_id: 5, network: 'zksync' }, { nft_id: 6 }], pagination: { next_cursor: null } }] }, urls);
  const positions = await revert.listPositions(WALLET, [...ALL]);
  assert.deepEqual(urls.map((url) => new URL(url).pathname).sort(), [`/v1/positions/uniswapv3/account/${WALLET}`, `/v1/positions/uniswapv4/account/${WALLET}`]);
  // Unknown networks and malformed rows are skipped.
  assert.deepEqual(positions.map((position) => position.id), ['5723933', '999']);

  const [closed, open] = positions;
  assert.equal(closed!.chainId, 42161);
  assert.equal(closed!.active, false);
  assert.equal(closed!.feeTier, 500);
  assert.equal(closed!.token0.symbol, 'WETH');
  assert.equal(closed!.token1.decimals, 6);
  near(closed!.priceLower, 2354.34);
  near(closed!.exitPrice, 2305.85);
  // $78.36 deposited at the deposit's prices, not Revert's deposits_value at today's prices ($75.86).
  near(closed!.depositedUsd, 78.364);
  near(closed!.withdrawnUsd, 74.543);
  near(closed!.feesEarnedUsd, 2.793);
  near(closed!.gasUsd, 0.041);
  near(closed!.pnlUsd, -1.0696); // Agrees with Revert's own -1.064 within rounding.
  // Tokens out minus tokens in at the exit prices: 0.013792 WETH × $2,305.85 − 33.078 USDC; Revert's usd.il (-3.82) also counts ETH's fall.
  near(closed!.ilUsd, -1.2758);
  near(closed!.feeAprPct, 63.34, 0.05);
  assert.equal(closed!.openedAt, '2026-10-08T18:33:34.000Z');
  assert.equal(closed!.closedAt, new Date(1793258847 * 1000).toISOString());
  assert.equal(closed!.historyAvailable, true);

  assert.equal(open!.chainId, 8453);
  assert.equal(open!.active, true);
  assert.equal(open!.inRange, true);
  assert.equal(open!.closedAt, undefined);
  near(open!.valueUsd, 49);
  near(open!.uncollectedFeesUsd, 0.54);
  near(open!.feesEarnedUsd, 1.54); // $1 claimed + $0.54 unclaimed.
  near(open!.pnlUsd, 1.44);
  near(open!.feeAprPct, 114.71, 0.05); // Over 10 days held.
  near(open!.ilUsd, 0); // Still holds exactly what was deposited.
});

test('keeps only the requested networks and follows pagination', async () => {
  const urls: string[] = [];
  const revert = client({ uniswapv3: [
    { success: true, data: [closedArbitrum], pagination: { next_cursor: 'page2' } },
    { success: true, data: [closedEthereum, openBase], pagination: { next_cursor: null } },
  ] }, urls);
  assert.deepEqual((await revert.listPositions(WALLET, [1, 42161])).map((position) => position.chainId), [42161, 1]);
  assert.ok(urls.some((url) => url.endsWith('&cursor=page2')));
});

test('reports unexpected responses and HTTP errors', async () => {
  await assert.rejects(client({ uniswapv3: [{ success: false }] }).listPositions(WALLET, [...ALL]), /Revert Finance returned an unexpected response/);
  const limited = new RevertClient({ retryDelayMs: 0, fetcher: async () => new Response('', { status: 429 }) });
  await assert.rejects(limited.listPositions(WALLET, [...ALL]), /Revert Finance.*HTTP 429.*rate limit/);
});

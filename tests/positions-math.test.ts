import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsForLiquidity, annualize, invertPrice, rangePosition, sqrtPriceX96ToPrice, tickToPrice } from '../src/positions-math.js';

const near = (actual: number, expected: number, relative = 1e-6) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relative, `${actual} ≉ ${expected}`);

test('converts ticks and sqrt prices to token1-per-token0 prices with decimals', () => {
  // WETH (18) / USDC (6) on Arbitrum: tick -198851 is 2,314.42 USDC per WETH (Revert showed 2,314.56 inside that tick).
  near(tickToPrice(-198851, 18, 6), 2314.42, 1e-5);
  near(tickToPrice(0, 18, 18), 1);
  const sqrt = BigInt(Math.round(Math.sqrt(2314.18e-12) * 2 ** 96));
  near(sqrtPriceX96ToPrice(sqrt, 18, 6), 2314.18, 1e-9);
});

test('splits liquidity into token amounts below, inside and above the range', () => {
  const liquidity = 10n ** 18n;
  const sqrtAt = (tick: number) => BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
  const [belowA, belowB] = amountsForLiquidity(liquidity, sqrtAt(-200), -100, 100, 18, 18);
  assert.ok(belowA > 0 && belowB === 0); // Price under the range: all token0.
  const [aboveA, aboveB] = amountsForLiquidity(liquidity, sqrtAt(200), -100, 100, 18, 18);
  assert.ok(aboveA === 0 && aboveB > 0); // Price over the range: all token1.
  const [insideA, insideB] = amountsForLiquidity(liquidity, sqrtAt(0), -100, 100, 18, 18);
  near(insideA, insideB, 1e-3); // Symmetric range at price 1: equal amounts.
  near(insideA, 1 - 1 / Math.sqrt(1.0001 ** 100), 1e-3);
});

test('quotes prices in stablecoins, then the wrapped native coin', () => {
  assert.equal(invertPrice('WETH', 'USDC'), false); // USDC per WETH already.
  assert.equal(invertPrice('USDC', 'WETH'), true);
  assert.equal(invertPrice('AAVE', 'WETH'), false);
  assert.equal(invertPrice('WETH', 'AAVE'), true);
  assert.equal(invertPrice('WBTC', 'WETH'), false);
  assert.equal(invertPrice('USDT', 'USDC'), false); // Equal rank: token1 quotes.
});

test('locates the price against the range and annualizes returns', () => {
  assert.deepEqual(rangePosition(2400, 2300, 2500), { side: 'in', distancePct: 0 });
  near(rangePosition(2254, 2300, 2500).distancePct, -2);
  assert.equal(rangePosition(2550, 2300, 2500).side, 'above');
  near(annualize(0.01, 10)!, 36.5);
  assert.equal(annualize(0.01, 0.01), undefined);
  assert.equal(annualize(undefined, 10), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsForLiquidity, liquidityForAmounts, MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK, minimumAmounts, Q96, sqrtRatioAtTick, tickAtOrBelowPrice, usableTickBounds } from '../src/v3-math.js';

test('sqrt prices at ticks match the Uniswap v3 TickMath contract', () => {
  assert.equal(sqrtRatioAtTick(0), Q96);
  assert.equal(sqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
  assert.equal(sqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
  // Every multiplier is used by some tick below; each result must agree with sqrt(1.0001^tick) × 2^96.
  for (const tick of [1, -1, 3, 60, -887, 10_000, -50_000, 123_457, -199_000, 262_143, -524_287, 887_271]) {
    const expected = Math.exp(tick * Math.log1p(0.0001) / 2) * 2 ** 96;
    assert.ok(Math.abs(Number(sqrtRatioAtTick(tick)) / expected - 1) < 1e-12, `tick ${tick}`);
  }
  assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), /outside/);
});

test('ticks from prices land at or below the price, exactly at tick boundaries', () => {
  assert.equal(tickAtOrBelowPrice(1), 0);
  assert.equal(tickAtOrBelowPrice(Math.exp(100 * Math.log1p(0.0001)) * 1.000001), 100);
  assert.equal(tickAtOrBelowPrice(Math.exp(100 * Math.log1p(0.0001)) * 0.999999), 99);
  // WETH/USDC on Base: $2,300 per WETH is 2300 × 10^6 / 10^18 raw.
  const tick = tickAtOrBelowPrice(2300e-12);
  assert.ok(1.0001 ** tick * 1e12 <= 2300 && 1.0001 ** (tick + 1) * 1e12 > 2300);
  assert.deepEqual(usableTickBounds(60), [-887220, 887220]);
});

test('liquidity and amounts round trip, with minimums below the desired amounts', () => {
  const [lower, upper, price] = [sqrtRatioAtTick(-200_000), sqrtRatioAtTick(-196_000), sqrtRatioAtTick(-198_000)];
  const desired: [bigint, bigint] = [10n ** 17n, 300n * 10n ** 6n];
  const liquidity = liquidityForAmounts(price, lower, upper, ...desired);
  const [amount0, amount1] = amountsForLiquidity(price, lower, upper, liquidity);
  // The mint uses all of one token and at most the desired amount of the other.
  assert.ok(amount0 <= desired[0] && amount1 <= desired[1], `${amount0} ${amount1}`);
  // The binding token is used up to rounding (liquidity rounds down): here WETH, within a millionth of a millionth.
  assert.ok(Number(desired[0] - amount0) / Number(desired[0]) < 1e-12, `${amount0}`);
  // A 0.5% price move shifts a concentrated position's amounts by several times that.
  const [min0, min1] = minimumAmounts(price, lower, upper, amount0, amount1, 0.005);
  assert.ok(min0 < amount0 && min0 > amount0 * 95n / 100n, `${min0} vs ${amount0}`);
  assert.ok(min1 < amount1 && min1 > amount1 * 95n / 100n, `${min1} vs ${amount1}`);
  // Out of range: one token only.
  assert.equal(amountsForLiquidity(sqrtRatioAtTick(-201_000), lower, upper, liquidity)[1], 0n);
  assert.equal(amountsForLiquidity(sqrtRatioAtTick(-195_000), lower, upper, liquidity)[0], 0n);
});

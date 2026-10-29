/**
 * Exact Uniswap v3 math in integers, as the core contracts and the official SDK compute it, for building
 * transactions: sqrt prices at ticks, liquidity for token amounts, and token amounts for liquidity.
 * (positions-math.ts uses floating point and is only for display.)
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 2n ** 96n;
const MAX_UINT256 = 2n ** 256n - 1n;

// TickMath.getSqrtRatioAtTick multipliers: 2^128 / sqrt(1.0001)^(2^i) for each bit i of |tick|.
const RATIOS: Array<[bigint, bigint]> = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) × 2^96, rounded up as the pool contract does. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`Tick ${tick} is outside the Uniswap v3 range.`);
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, multiplier] of RATIOS) if (abs & bit) ratio = (ratio * multiplier) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** The closest tick at or below a raw price (token1 units per token0 unit, without decimals). */
export function tickAtOrBelowPrice(rawPrice: number): number {
  if (!(rawPrice > 0) || !Number.isFinite(rawPrice)) throw new Error('Price must be a positive number.');
  let tick = Math.floor(Math.log(rawPrice) / Math.log(1.0001));
  tick = Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
  // Floating-point logs can be off by one near a tick boundary; settle it against the exact sqrt price.
  const root = Math.sqrt(rawPrice);
  const exponent = Math.floor(Math.log2(root));
  const mantissa = BigInt(Math.round(root / 2 ** exponent * 2 ** 52));
  const shift = 96 + exponent - 52;
  const target = shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
  while (tick > MIN_TICK && sqrtRatioAtTick(tick) > target) tick -= 1;
  while (tick < MAX_TICK && sqrtRatioAtTick(tick + 1) <= target) tick += 1;
  return tick;
}

/** The lowest and highest ticks a pool with this spacing accepts. */
export const usableTickBounds = (spacing: number): [number, number] => [Math.ceil(MIN_TICK / spacing) * spacing, Math.floor(MAX_TICK / spacing) * spacing];

const mulDiv = (a: bigint, b: bigint, denominator: bigint): bigint => (a * b) / denominator;
const mulDivUp = (a: bigint, b: bigint, denominator: bigint): bigint => { const product = a * b; return product / denominator + (product % denominator ? 1n : 0n); };
const ordered = (a: bigint, b: bigint): [bigint, bigint] => a > b ? [b, a] : [a, b];

/** Liquidity that amount0 buys between two sqrt prices (full precision, as the SDK's maxLiquidityForAmount0Precise). */
export function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [lower, upper] = ordered(sqrtA, sqrtB);
  return mulDiv(amount0 * lower, upper, Q96 * (upper - lower));
}

export function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [lower, upper] = ordered(sqrtA, sqrtB);
  return mulDiv(amount1, Q96, upper - lower);
}

/** The most liquidity both amounts can fund at the current price, as LiquidityAmounts.getLiquidityForAmounts. */
export function liquidityForAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  const [lower, upper] = ordered(sqrtA, sqrtB);
  if (sqrtPrice <= lower) return liquidityForAmount0(lower, upper, amount0);
  if (sqrtPrice < upper) {
    const from0 = liquidityForAmount0(sqrtPrice, upper, amount0);
    const from1 = liquidityForAmount1(lower, sqrtPrice, amount1);
    return from0 < from1 ? from0 : from1;
  }
  return liquidityForAmount1(lower, upper, amount1);
}

/** Token amounts a mint of this liquidity takes from the wallet, rounded up as the pool rounds them. */
export function amountsForLiquidity(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  const [lower, upper] = ordered(sqrtA, sqrtB);
  const amount0 = (from: bigint) => mulDivUp(mulDivUp(liquidity << 96n, upper - from, upper), 1n, from);
  const amount1 = (to: bigint) => mulDivUp(liquidity, to - lower, Q96);
  if (sqrtPrice <= lower) return [amount0(lower), 0n];
  if (sqrtPrice < upper) return [amount0(sqrtPrice), amount1(sqrtPrice)];
  return [0n, amount1(upper)];
}

/**
 * Minimum amounts for mint's slippage check, as the Uniswap SDK's mintAmountsWithSlippage: the liquidity the desired
 * amounts fund now, valued at the price moved up by the tolerance (least token0) and down by it (least token1).
 */
export function minimumAmounts(sqrtPrice: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint, slippage: number): [bigint, bigint] {
  const liquidity = liquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1);
  const scaled = (factor: number) => {
    const value = mulDiv(sqrtPrice, BigInt(Math.round(Math.sqrt(factor) * 1e12)), 10n ** 12n);
    return value < MIN_SQRT_RATIO ? MIN_SQRT_RATIO : value > MAX_SQRT_RATIO ? MAX_SQRT_RATIO : value;
  };
  return [amountsForLiquidity(scaled(1 + slippage), sqrtA, sqrtB, liquidity)[0], amountsForLiquidity(scaled(1 - slippage), sqrtA, sqrtB, liquidity)[1]];
}

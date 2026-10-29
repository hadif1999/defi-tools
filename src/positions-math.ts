/**
 * Concentrated-liquidity math for displaying positions. Values are JavaScript numbers: exact enough for prices
 * and token amounts shown to a few significant digits, not for building transactions.
 */

const Q96 = 2 ** 96;

/** Price of token0 in token1 at a tick, decimals applied. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}

/** Price of token0 in token1 from a pool's sqrtPriceX96, decimals applied. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  return (Number(sqrtPriceX96) / Q96) ** 2 * 10 ** (decimals0 - decimals1);
}

/** Token amounts (decimals applied) held by a position's liquidity at the current price. */
export function amountsForLiquidity(liquidity: bigint, sqrtPriceX96: bigint, tickLower: number, tickUpper: number, decimals0: number, decimals1: number): [number, number] {
  const L = Number(liquidity);
  const p = Number(sqrtPriceX96) / Q96;
  const a = Math.sqrt(1.0001 ** tickLower);
  const b = Math.sqrt(1.0001 ** tickUpper);
  const [raw0, raw1] = p <= a ? [L * (b - a) / (a * b), 0] : p >= b ? [0, L * (b - a)] : [L * (b - p) / (p * b), L * (p - a)];
  return [raw0 / 10 ** decimals0, raw1 / 10 ** decimals1];
}

const STABLES = new Set(['usdc', 'usdt', 'dai', 'usds', 'usde', 'usdc.e', 'usdbc', 'usdt0', 'fdusd', 'busd', 'pyusd', 'frax', 'lusd', 'gho', 'crvusd', 'tusd']);
const NATIVES = new Set(['weth', 'eth', 'wbnb', 'bnb', 'wpol', 'pol', 'wmatic', 'matic']);
const BTC = new Set(['wbtc', 'cbbtc', 'btcb', 'tbtc']);
const quoteRank = (symbol: string): number => {
  const name = symbol.toLowerCase();
  return STABLES.has(name) ? 3 : NATIVES.has(name) ? 2 : BTC.has(name) ? 1 : 0;
};

/**
 * Whether prices read better as token0 per token1 (inverted). Prices are quoted in the more "money-like" token,
 * as the Uniswap app does: stablecoins, then the wrapped native coin, then BTC; otherwise in token1.
 */
export function invertPrice(symbol0: string, symbol1: string): boolean {
  return quoteRank(symbol0) > quoteRank(symbol1);
}

export type RangeSide = 'in' | 'below' | 'above';

/** Where the current price sits relative to the range, and how far outside it is in percent (0 when inside). */
export function rangePosition(price: number, lower: number, upper: number): { side: RangeSide; distancePct: number } {
  if (price < lower) return { side: 'below', distancePct: (price / lower - 1) * 100 };
  if (price > upper) return { side: 'above', distancePct: (price / upper - 1) * 100 };
  return { side: 'in', distancePct: 0 };
}

/** Annualize a return over the days held; undefined for under an hour, where the figure would be meaningless. */
export function annualize(ratio: number | undefined, days: number): number | undefined {
  return ratio === undefined || !Number.isFinite(ratio) || days < 1 / 24 ? undefined : ratio * 365 / days * 100;
}

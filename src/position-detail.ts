import type { Candle } from './dex-data.js';
import { invertPrice, rangePosition, tickToPrice } from './positions-math.js';
import { CHAINS, type EvmChainId, type LpPosition, type PositionEvent } from './types.js';

// positions detail: one position analysed in depth. Prices are shown the way positions list shows them, in the more
// money-like token (USDC per WETH), and every figure is derived from the position, its transactions and the pool's
// candles, so the terminal view, the HTML report and --json all tell the same story.

export type DetailStatus = 'in' | 'below' | 'above' | 'closed';

export interface DetailToken { symbol: string; address: string; decimals?: number; priceUsd?: number }

/** One price on the value-vs-price curve: what the liquidity holds there, against holding the tokens it had at entry. */
export interface CurvePoint {
  price: number;
  /** Position value in the quote token. */
  value: number;
  /** Value of the tokens the liquidity held at the reference price, held instead, in the quote token. */
  hodl: number;
  base: number;
  quote: number;
  /** Impermanent loss against holding, in percent (0 or negative). */
  ilPct: number;
}

export interface Scenario {
  label: string;
  /** Move from the current price, in percent. */
  movePct: number;
  price: number;
  base: number;
  quote: number;
  /** Position value in the quote token, and in USD at today's quote-token price. */
  value: number;
  valueUsd?: number;
  /** Against holding the entry tokens, in percent. */
  vsHodlPct: number;
  /** Lifetime PnL in USD if the price moved there now, fees earned so far included. */
  pnlUsd?: number;
  inRange: boolean;
}

export interface DetailEvent extends PositionEvent {
  base: number;
  quote: number;
  /** Price in the shown unit. */
  displayPrice?: number;
}

export interface PositionDetail {
  id: string;
  chainId: EvmChainId;
  chain: string;
  dex: string;
  protocol: string;
  pool?: string;
  wallet: string;
  walletName?: string;
  feeTier?: number;
  tickLower: number;
  tickUpper: number;
  currentTick?: number;
  tickSpacing?: number;
  active: boolean;
  status: DetailStatus;
  /** BASE/QUOTE, e.g. WETH/USDC. */
  pair: string;
  base: DetailToken;
  quote: DetailToken;
  /** "USDC per WETH". */
  unit: string;
  /** True when shown prices are token0 per token1. */
  inverted: boolean;
  prices: {
    lower: number;
    upper: number;
    current?: number;
    /** Live price from the pool's market data, when read. */
    live?: number;
    /** Price of the first deposit; average entry is liquidity-weighted over deposits. */
    entry?: number;
    averageEntry?: number;
    exit?: number;
    /** Geometric middle of the range. */
    middle: number;
    widthPct: number;
    /** From the current price to each limit, in percent of the current price. */
    toLowerPct?: number;
    toUpperPct?: number;
    /** Where the current price sits in the range on a log scale: 0 at the lower limit, 100 at the upper one. */
    rangePositionPct?: number;
    /** Distance outside the range, in percent (0 inside). */
    outsidePct?: number;
    /** Limits relative to the entry price, in percent. */
    lowerFromEntryPct?: number;
    upperFromEntryPct?: number;
  };
  holdings: { base?: number; quote?: number; valueQuote?: number; valueUsd?: number; baseSharePct?: number };
  liquidity: {
    raw: string;
    /** Liquidity in token units (√(base·quote)), used for the curve; from today's liquidity or, for closed positions, the deposit's. */
    units?: number;
    /** Capital needed by a full-range position for the same liquidity at the current price (entry price once closed), as a multiple of this one's. */
    efficiency?: number;
    curveFrom: 'current' | 'deposit' | 'none';
  };
  flows: {
    deposited: { base: number; quote: number; usd?: number };
    withdrawn: { base: number; quote: number; usd?: number };
    collected: { base: number; quote: number; usd?: number };
    uncollected: { base?: number; quote?: number; usd?: number };
  };
  performance: {
    depositedUsd?: number;
    withdrawnUsd?: number;
    valueUsd?: number;
    feesUsd?: number;
    gasUsd?: number;
    pnlUsd?: number;
    pnlPct?: number;
    ilUsd?: number;
    /** The deposited tokens, held instead, at today's prices (exit prices for a closed position). */
    hodlUsd?: number;
    /** PnL minus what holding would have made: value + withdrawals + fees − gas − hodl. */
    vsHodlUsd?: number;
    feeAprPct?: number;
    totalAprPct?: number;
    feesPerDayUsd?: number;
    /** Fees earned as a percentage of the impermanent loss (100 = fees made up for it). */
    feesCoverIlPct?: number;
    daysHeld?: number;
    /** Price above which lifetime PnL is positive, at today's quote-token USD price (open positions). */
    breakeven?: number;
  };
  history?: {
    timeframe: string;
    step: number;
    /** Candles while the position was open. */
    candles: number;
    inRangePct?: number;
    /** Times the price left the range while the position was open. */
    exits?: number;
    high?: number;
    low?: number;
    /** Annualized volatility of the price while open, in percent. */
    volatilityPct?: number;
    dailyVolatilityPct?: number;
    /** How many days a typical move takes to reach each limit, from the current price ((distance/σ)² days). */
    daysToLower?: number;
    daysToUpper?: number;
    lastInRangeAt?: number;
  };
  curve: CurvePoint[];
  /** The price the curve's holding line is measured from: entry, or the current price without history. */
  curveReference?: number;
  scenarios: Scenario[];
  events: DetailEvent[];
  openedAt?: string;
  closedAt?: string;
  source: 'revert' | 'rpc';
  historyAvailable: boolean;
  links: { position?: string; pool?: string; wallet?: string; explorer?: string };
}

const EXPLORERS: Partial<Record<EvmChainId, string>> = {
  1: 'https://etherscan.io', 10: 'https://optimistic.etherscan.io', 56: 'https://bscscan.com', 137: 'https://polygonscan.com', 8453: 'https://basescan.org', 42161: 'https://arbiscan.io',
};
const UNISWAP_CHAINS: Partial<Record<EvmChainId, string>> = { 1: 'ethereum', 10: 'optimism', 56: 'bnb', 137: 'polygon', 8453: 'base', 42161: 'arbitrum' };
/** Uniswap v3's tick spacing for each fee tier; v4 pools choose their own. */
const V3_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10_000: 200 };

/** Transaction link on the network's block explorer. */
export const txLink = (chainId: EvmChainId, hash: string): string | undefined => EXPLORERS[chainId] && `${EXPLORERS[chainId]}/tx/${hash}`;

/** Token amounts held by `units` of liquidity at price P (token1 per token0), between Pa and Pb. */
export function amountsAt(units: number, price: number, lower: number, upper: number): [number, number] {
  const [p, a, b] = [Math.sqrt(price), Math.sqrt(lower), Math.sqrt(upper)];
  if (p <= a) return [units * (b - a) / (a * b), 0];
  if (p >= b) return [0, units * (b - a)];
  return [units * (b - p) / (p * b), units * (p - a)];
}

/** Liquidity (token units) that holds these amounts at price P; the smaller side wins, as the pool does when minting. */
export function unitsFor(amount0: number, amount1: number, price: number, lower: number, upper: number): number | undefined {
  const [p, a, b] = [Math.sqrt(price), Math.sqrt(lower), Math.sqrt(upper)];
  const from0 = amount0 > 0 ? amount0 * Math.max(p, a) * b / (b - Math.max(p, a)) : undefined;
  const from1 = amount1 > 0 ? amount1 / (Math.min(p, b) - a) : undefined;
  if (p <= a) return from0;
  if (p >= b) return from1;
  const options = [from0, from1].filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  return options.length ? Math.min(...options) : undefined;
}

/**
 * How much more capital a full-range position needs for the same liquidity at price P: 2√P ÷ (2√P − √Pa − P/√Pb).
 * Undefined outside the range, where the position holds one token and earns no fees.
 */
export function capitalEfficiency(price: number, lower: number, upper: number): number | undefined {
  if (!(price > lower && price < upper)) return undefined;
  const p = Math.sqrt(price);
  return 2 * p / (2 * p - Math.sqrt(lower) - price / Math.sqrt(upper));
}

export interface DetailInput {
  position: LpPosition;
  /** The pool's candles in the shown unit, covering at least the time the position was open. */
  candles?: Candle[];
  timeframe?: string;
  step?: number;
  /** Live price in the shown unit. */
  livePrice?: number;
  now: number;
}

/** Everything positions detail shows about one position. */
export function analyzePositionDetail(input: DetailInput): PositionDetail {
  const { position } = input;
  const inverted = invertPrice(position.token0.symbol, position.token1.symbol);
  const [baseToken, quoteToken] = inverted ? [position.token1, position.token0] : [position.token0, position.token1];
  // Raw prices are token1 per token0; shown prices are quote per base.
  const show = (raw: number | undefined) => raw === undefined || !Number.isFinite(raw) || raw <= 0 ? undefined : inverted ? 1 / raw : raw;
  const raw = (shown: number) => inverted ? 1 / shown : shown;
  const split = (amount0: number, amount1: number) => inverted ? { base: amount1, quote: amount0 } : { base: amount0, quote: amount1 };
  const known = position.token0.decimals !== undefined && position.token1.decimals !== undefined;
  const rawLower = position.priceLower ?? (known ? tickToPrice(position.tickLower, position.token0.decimals!, position.token1.decimals!) : undefined);
  const rawUpper = position.priceUpper ?? (known ? tickToPrice(position.tickUpper, position.token0.decimals!, position.token1.decimals!) : undefined);
  if (rawLower === undefined || rawUpper === undefined) throw new Error(`Position #${position.id} has no price range (token decimals are unknown).`);
  const [lower, upper] = [show(rawLower), show(rawUpper)].sort((a, b) => a! - b!) as [number, number];
  const current = show(position.price);
  const priced = input.livePrice ?? current;

  const events: DetailEvent[] = (position.events ?? []).map((event) => ({ ...event, ...split(event.amount0, event.amount1), displayPrice: show(event.price) }));
  const deposits = events.filter((event) => event.kind === 'deposit');
  const total = (kind: PositionEvent['kind']) => {
    const list = events.filter((event) => event.kind === kind);
    const usd = list.every((event) => event.valueUsd !== undefined) ? list.reduce((sum, event) => sum + event.valueUsd!, 0) : undefined;
    return { base: list.reduce((sum, event) => sum + event.base, 0), quote: list.reduce((sum, event) => sum + event.quote, 0), usd: list.length ? usd : 0 };
  };
  const entry = deposits[0]?.displayPrice;
  // Average entry weighted by the value each deposit added.
  const weighted = deposits.filter((event) => event.displayPrice !== undefined);
  const weight = (event: DetailEvent) => event.valueUsd ?? event.base * event.displayPrice! + event.quote;
  const averageEntry = weighted.length > 1 ? weighted.reduce((sum, event) => sum + event.displayPrice! * weight(event), 0) / weighted.reduce((sum, event) => sum + weight(event), 0) : entry;
  const exit = show(position.exitPrice);

  // Liquidity in token units: today's, else the first deposit's (closed positions), else from the deposited amounts.
  const decimalsScale = known ? 10 ** ((position.token0.decimals! + position.token1.decimals!) / 2) : undefined;
  let units: number | undefined;
  let curveFrom: PositionDetail['liquidity']['curveFrom'] = 'none';
  if (decimalsScale && Number(position.liquidity) > 0) { units = Number(position.liquidity) / decimalsScale; curveFrom = 'current'; }
  else if (decimalsScale && position.depositLiquidity && Number(position.depositLiquidity) > 0) { units = Number(position.depositLiquidity) / decimalsScale; curveFrom = 'deposit'; }
  else if (deposits[0]?.price !== undefined) {
    units = unitsFor(deposits[0].amount0, deposits[0].amount1, deposits[0].price, rawLower, rawUpper);
    if (units) curveFrom = 'deposit';
  } else if (position.amount0 !== undefined && position.amount1 !== undefined && position.price !== undefined && (position.amount0 > 0 || position.amount1 > 0)) {
    units = unitsFor(position.amount0, position.amount1, position.price, rawLower, rawUpper);
    if (units) curveFrom = 'current';
  }

  const holdingsAt = (shown: number) => {
    const [amount0, amount1] = amountsAt(units!, raw(shown), rawLower, rawUpper);
    const { base, quote } = split(amount0, amount1);
    return { base, quote, value: base * shown + quote };
  };
  // The curve compares the liquidity with holding the tokens it had at entry (or today, without history).
  const reference = entry ?? current;
  const curve: CurvePoint[] = [];
  if (units && reference) {
    const start = holdingsAt(reference);
    const marks = [lower, upper, current, entry, exit, input.livePrice].filter((value): value is number => value !== undefined);
    const [low, high] = [Math.min(...marks) / 1.3, Math.max(...marks) * 1.3];
    const prices = Array.from({ length: 241 }, (_, i) => low * (high / low) ** (i / 240));
    for (const price of [...prices, ...marks].sort((a, b) => a - b)) {
      if (curve.at(-1)?.price === price) continue;
      const here = holdingsAt(price);
      const hodl = start.base * price + start.quote;
      curve.push({ price, value: here.value, hodl, base: here.base, quote: here.quote, ilPct: hodl > 0 ? (here.value / hodl - 1) * 100 : 0 });
    }
  }

  const status: DetailStatus = !position.active ? 'closed' : priced === undefined ? (position.inRange === false ? 'below' : 'in') : rangePosition(priced, lower, upper).side;
  const holdings: PositionDetail['holdings'] = {};
  if (position.amount0 !== undefined && position.amount1 !== undefined) {
    const { base, quote } = split(position.amount0, position.amount1);
    Object.assign(holdings, { base, quote });
    if (current !== undefined) {
      holdings.valueQuote = base * current + quote;
      holdings.baseSharePct = holdings.valueQuote > 0 ? base * current / holdings.valueQuote * 100 : undefined;
    }
    holdings.valueUsd = position.valueUsd;
  }

  const flows: PositionDetail['flows'] = {
    deposited: total('deposit'), withdrawn: total('withdraw'), collected: total('collect'),
    uncollected: { ...(position.uncollectedFees0 !== undefined && position.uncollectedFees1 !== undefined ? split(position.uncollectedFees0, position.uncollectedFees1) : {}), usd: position.uncollectedFeesUsd },
  };
  const opened = position.openedAt ? Date.parse(position.openedAt) / 1000 : deposits[0]?.timestamp;
  const closed = position.closedAt ? Date.parse(position.closedAt) / 1000 : undefined;
  const daysHeld = opened === undefined ? undefined : ((closed ?? input.now) - opened) / 86_400;
  // The deposited tokens, held instead: at the exit for a closed position, at today's prices for an open one.
  const [usd0, usd1] = position.active ? [position.token0.priceUsd, position.token1.priceUsd] : [undefined, undefined];
  const exitEvent = [...events].reverse().find((event) => event.kind === 'withdraw');
  const hodlPrices = usd0 !== undefined && usd1 !== undefined ? split(usd0, usd1) : undefined;
  let hodlUsd: number | undefined;
  if (deposits.length && hodlPrices) hodlUsd = flows.deposited.base * hodlPrices.base + flows.deposited.quote * hodlPrices.quote;
  else if (deposits.length && !position.active && exitEvent && exitEvent.displayPrice !== undefined && exitEvent.valueUsd !== undefined && exitEvent.base * exitEvent.displayPrice + exitEvent.quote > 0) {
    // At the exit: the withdrawal's own USD value per quote token converts quote-token values to USD.
    const quoteUsd = exitEvent.valueUsd / (exitEvent.base * exitEvent.displayPrice + exitEvent.quote);
    hodlUsd = (flows.deposited.base * exitEvent.displayPrice + flows.deposited.quote) * quoteUsd;
  }
  const out = (position.valueUsd ?? 0) + (position.withdrawnUsd ?? 0) + (position.feesEarnedUsd ?? 0) - (position.gasUsd ?? 0);
  const performance: PositionDetail['performance'] = {
    depositedUsd: position.depositedUsd, withdrawnUsd: position.withdrawnUsd, valueUsd: position.valueUsd, feesUsd: position.feesEarnedUsd, gasUsd: position.gasUsd,
    pnlUsd: position.pnlUsd, pnlPct: position.pnlUsd !== undefined && position.depositedUsd ? position.pnlUsd / position.depositedUsd * 100 : undefined,
    ilUsd: position.ilUsd, hodlUsd, vsHodlUsd: hodlUsd !== undefined && position.historyAvailable ? out - hodlUsd : undefined,
    feeAprPct: position.feeAprPct, totalAprPct: position.totalAprPct,
    feesPerDayUsd: position.feesEarnedUsd !== undefined && daysHeld && daysHeld >= 1 / 24 ? position.feesEarnedUsd / daysHeld : undefined,
    feesCoverIlPct: position.feesEarnedUsd !== undefined && position.ilUsd !== undefined && position.ilUsd < -0.005 ? position.feesEarnedUsd / -position.ilUsd * 100 : undefined,
    daysHeld,
  };

  // What-if prices: lifetime PnL at each, with the fees earned so far and the quote token at today's USD price.
  const scenarios: Scenario[] = [];
  const quoteUsd = quoteToken.priceUsd;
  const pnlAt = (value: number) => position.historyAvailable && quoteUsd !== undefined && position.depositedUsd !== undefined
    ? value * quoteUsd + (position.withdrawnUsd ?? 0) + (position.feesEarnedUsd ?? 0) - position.depositedUsd - (position.gasUsd ?? 0) : undefined;
  if (position.active && units && priced !== undefined && reference !== undefined) {
    const start = holdingsAt(reference);
    const point = (label: string, price: number): Scenario => {
      const here = holdingsAt(price);
      const hodl = start.base * price + start.quote;
      return { label, movePct: (price / priced - 1) * 100, price, base: here.base, quote: here.quote, value: here.value,
        valueUsd: quoteUsd === undefined ? undefined : here.value * quoteUsd, vsHodlPct: hodl > 0 ? (here.value / hodl - 1) * 100 : 0, pnlUsd: pnlAt(here.value), inRange: price >= lower && price <= upper };
    };
    const moves = [-50, -30, -20, -10, -5, 0, 5, 10, 20, 30, 50].map((move) => point(move === 0 ? 'Now' : `${move > 0 ? '+' : ''}${move}%`, priced * (1 + move / 100)));
    scenarios.push(...moves, point('At lower limit', lower), point('At upper limit', upper));
    scenarios.sort((a, b) => a.price - b.price);
    // PnL in the quote token rises with the price (more of the value is the priced token), so there is one breakeven.
    if (pnlAt(holdingsAt(priced).value) !== undefined) {
      const pnl = (price: number) => pnlAt(holdingsAt(price).value)!;
      let [low, high] = [lower / 100, upper * 100];
      if (pnl(low) < 0 && pnl(high) >= 0) {
        for (let i = 0; i < 80; i += 1) { const mid = Math.sqrt(low * high); if (pnl(mid) >= 0) high = mid; else low = mid; }
        performance.breakeven = high;
      }
    }
  }

  // The price while the position was open, from the pool's candles.
  let history: PositionDetail['history'];
  if (input.candles?.length && input.step) {
    const end = closed ?? input.now;
    const held = input.candles.filter((candle) => (opened === undefined || candle.timestamp + input.step! > opened) && candle.timestamp < end);
    const inside = (candle: Candle) => candle.close >= lower && candle.close <= upper;
    let exits = 0;
    held.forEach((candle, i) => { if (i && inside(held[i - 1]!) && !inside(candle)) exits += 1; });
    const returns = held.slice(1).map((candle, i) => Math.log(candle.close / held[i]!.close)).filter(Number.isFinite);
    const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    // Volatility from the whole chart is steadier than from a short holding period alone.
    const all = input.candles.slice(1).map((candle, i) => Math.log(candle.close / input.candles![i]!.close)).filter(Number.isFinite);
    const allMean = all.reduce((sum, value) => sum + value, 0) / (all.length || 1);
    const allVariance = all.reduce((sum, value) => sum + (value - allMean) ** 2, 0) / Math.max(1, all.length - 1);
    const daily = all.length > 1 ? Math.sqrt(allVariance * 86_400 / input.step) : undefined;
    const reach = (from: number, to: number) => daily && daily > 0 ? (Math.log(to / from) / daily) ** 2 : undefined;
    const lastInside = [...input.candles].reverse().find(inside);
    history = {
      timeframe: input.timeframe ?? '', step: input.step, candles: held.length,
      inRangePct: held.length ? held.filter(inside).length / held.length * 100 : undefined, exits: held.length ? exits : undefined,
      high: held.length ? Math.max(...held.map((candle) => candle.high)) : undefined, low: held.length ? Math.min(...held.map((candle) => candle.low)) : undefined,
      volatilityPct: returns.length > 1 ? Math.sqrt(variance * 365 * 86_400 / input.step) * 100 : undefined,
      dailyVolatilityPct: daily === undefined ? undefined : daily * 100,
      daysToLower: position.active && status === 'in' && priced !== undefined ? reach(priced, lower) : undefined,
      daysToUpper: position.active && status === 'in' && priced !== undefined ? reach(priced, upper) : undefined,
      lastInRangeAt: lastInside?.timestamp,
    };
  }

  const where = priced === undefined ? undefined : rangePosition(priced, lower, upper);
  const chainSlug = UNISWAP_CHAINS[position.chainId];
  const explorer = EXPLORERS[position.chainId];
  return {
    id: position.id, chainId: position.chainId, chain: CHAINS[position.chainId].name, dex: position.dex, protocol: position.protocol, pool: position.pool,
    wallet: position.wallet, walletName: position.walletName, feeTier: position.feeTier,
    tickLower: position.tickLower, tickUpper: position.tickUpper, currentTick: position.currentTick,
    tickSpacing: position.protocol === 'v3' && position.feeTier !== undefined ? V3_SPACING[position.feeTier] : undefined,
    active: position.active, status,
    pair: `${baseToken.symbol}/${quoteToken.symbol}`, base: { ...baseToken }, quote: { ...quoteToken }, unit: `${quoteToken.symbol} per ${baseToken.symbol}`, inverted,
    prices: {
      lower, upper, current, live: input.livePrice, entry, averageEntry, exit, middle: Math.sqrt(lower * upper), widthPct: (upper / lower - 1) * 100,
      toLowerPct: priced === undefined ? undefined : (lower / priced - 1) * 100, toUpperPct: priced === undefined ? undefined : (upper / priced - 1) * 100,
      rangePositionPct: priced === undefined ? undefined : Math.log(priced / lower) / Math.log(upper / lower) * 100,
      outsidePct: where?.distancePct,
      lowerFromEntryPct: entry === undefined ? undefined : (lower / entry - 1) * 100, upperFromEntryPct: entry === undefined ? undefined : (upper / entry - 1) * 100,
    },
    holdings,
    liquidity: { raw: position.liquidity, units, efficiency: (position.active ? priced : entry) === undefined ? undefined : capitalEfficiency(raw((position.active ? priced : entry)!), Math.min(rawLower, rawUpper), Math.max(rawLower, rawUpper)), curveFrom },
    flows, performance, history, curve, curveReference: curve.length ? reference : undefined, scenarios, events,
    openedAt: position.openedAt, closedAt: position.closedAt, source: position.source, historyAvailable: position.historyAvailable,
    links: {
      position: chainSlug ? `https://app.uniswap.org/positions/${position.protocol}/${chainSlug}/${position.id}` : undefined,
      pool: explorer && position.pool && position.pool.length === 42 ? `${explorer}/address/${position.pool}` : undefined,
      wallet: explorer ? `${explorer}/address/${position.wallet}` : undefined,
      explorer,
    },
  };
}

/**
 * The position a reference names: its NFT ID (#123 or 123), else a row number of positions list's open table
 * (or the closed table with `past`, or when nothing is open). An ID shared by positions on several networks needs --chain.
 */
export function pickPosition(positions: LpPosition[], reference: string, options: { past?: boolean; ordered: { active: LpPosition[]; past: LpPosition[] } }): { position: LpPosition; how: string } {
  const text = reference.trim().replace(/^#/, '');
  if (!/^\d+$/.test(text)) throw new Error(`"${reference}" is neither a position ID nor a row number of defi-tool positions list.`);
  const byId = positions.filter((position) => position.id === text);
  if (byId.length > 1) throw new Error(`Position ID ${text} exists on ${byId.map((position) => CHAINS[position.chainId].name).join(' and ')}; add --chain to pick one.`);
  if (byId.length === 1) return { position: byId[0]!, how: `position #${text}` };
  if (reference.trim().startsWith('#')) throw new Error(`No position #${text} among the wallets read. Check the ID with defi-tool positions list.`);
  const row = Number(text);
  const table = options.past || !options.ordered.active.length ? 'past' : 'active';
  const list = options.ordered[table];
  const position = list[row - 1];
  const name = table === 'past' ? 'closed' : 'open';
  if (!position) {
    throw new Error(list.length ? `There is no row ${row} among the ${list.length} ${name} position${list.length === 1 ? '' : 's'}, and no position has ID ${text}. See defi-tool positions list.`
      : `No ${name} positions to pick row ${row} from, and no position has ID ${text}.`);
  }
  return { position, how: `row ${row} of the ${name} positions (#${position.id})` };
}

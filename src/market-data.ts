import { CHART_POINTS, coinSymbols, priceChart, type ChartSeries } from './providers/prices.js';
import { searchCoins } from './providers/coingecko.js';
import { alignRange, fileStamp, JUMP, safeName, writeRows, type CandleColumn, type CandleFormat, type FillMode } from './candle-files.js';

// Market prices across all venues: DefiLlama's blended USD price per coin (no key), sampled and built into candles.

export const MARKET_TIMEFRAMES = { '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '12h': 43_200, '1d': 86_400, '1w': 604_800 } as const;
export type MarketTimeframe = keyof typeof MARKET_TIMEFRAMES;
/** Sample spacings DefiLlama serves; it keeps prices about every 5 minutes. */
export const SAMPLE_PERIODS = { '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400 } as const;
export type SamplePeriod = keyof typeof SAMPLE_PERIODS;
/** Weekly candles start on Monday 00:00 UTC; the unix epoch fell on a Thursday. */
const WEEK_OFFSET = 4 * 86_400;
/** Auto sampling aims for at least this many samples per candle. */
const SAMPLES_PER_CANDLE = 12;

/** The widest sample spacing that still gives about 12 samples per candle (5m for 1h candles, 1h for 1d); never finer than 5m. */
export function autoSample(timeframe: MarketTimeframe): SamplePeriod {
  const step = MARKET_TIMEFRAMES[timeframe];
  return (Object.keys(SAMPLE_PERIODS) as SamplePeriod[]).filter((period) => step / SAMPLE_PERIODS[period] >= SAMPLES_PER_CANDLE).at(-1) ?? '5m';
}

/** The candle periods to build, [start, end) aligned to the timeframe (weeks start on Monday). */
export function marketRange(timeframe: MarketTimeframe, from: number, to: number, now: number, includePartial: boolean): { start: number; end: number } {
  return alignRange(MARKET_TIMEFRAMES[timeframe], timeframe, from, to, now, includePartial, undefined, timeframe === '1w' ? WEEK_OFFSET : 0);
}

/** A coin as DefiLlama keys it ("coingecko:ethereum", "base:0x…"), or the US dollar itself. */
export interface Coin { key: string; symbol: string; name?: string }
export const USD: Coin = { key: 'usd', symbol: 'USD', name: 'US dollar' };
const isUsd = (coin: Coin) => coin.key === USD.key;

/** "ETH" → ETH/USD; "BTC/ETH" → BTC priced in ETH. Tokens are kept as typed; lookups ignore case. */
export function parseMarketPair(text: string): [string, string] {
  const parts = text.split('/').map((part) => part.trim());
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error(`Pair "${text}" needs one token (ETH, priced in USD) or two joined by /, e.g. BTC/ETH.`);
  if (parts[0]!.toLowerCase() === 'usd') throw new Error(`Pair "${text}" prices USD itself; put the coin first, e.g. ETH/USD.`);
  return [parts[0]!, parts[1] ?? 'USD'];
}

/**
 * A coin from what the user typed: USD; a DefiLlama key (coingecko:ethereum, or chain:address such as base:0x…), checked
 * with DefiLlama, which also gives its symbol; or a symbol, looked up on CoinGecko, where the coin with that exact
 * symbol and the best market-cap rank wins.
 */
export async function resolveCoin(query: string, search: (query: string) => ReturnType<typeof searchCoins>,
  symbols: (keys: string[]) => ReturnType<typeof coinSymbols>): Promise<Coin> {
  const text = query.trim();
  if (text.toLowerCase() === 'usd') return USD;
  if (text.includes(':')) {
    const [prefix, ...rest] = text.split(':');
    const id = rest.join(':');
    // CoinGecko IDs and EVM addresses ignore case; Solana addresses do not.
    const key = `${prefix!.toLowerCase()}:${/^0x[0-9a-f]+$/i.test(id) || prefix!.toLowerCase() === 'coingecko' ? id.toLowerCase() : id}`;
    const symbol = (await symbols([key])).get(key.toLowerCase());
    if (!symbol) throw new Error(`DefiLlama has no price for ${key}. Check the CoinGecko ID or the chain:address (chains as DefiLlama names them: ethereum, base, arbitrum, solana, ...).`);
    return { key, symbol };
  }
  const symbol = text.toLowerCase();
  const matches = (await search(text)).filter((coin) => coin.symbol.toLowerCase() === symbol);
  if (!matches.length) throw new Error(`No coin with the symbol "${text}" on CoinGecko. Use its CoinGecko ID (coingecko:<id>) or a token address (base:0x…).`);
  const best = [...matches].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0]!;
  return { key: `coingecko:${best.id}`, symbol: best.symbol.toUpperCase(), name: best.name };
}

/** The sample spacings auto mode tries for a timeframe: its usual one first, then coarser ones that still fit in a candle. */
export function sampleCandidates(timeframe: MarketTimeframe): SamplePeriod[] {
  const first = SAMPLE_PERIODS[autoSample(timeframe)];
  return (Object.keys(SAMPLE_PERIODS) as SamplePeriod[]).filter((period) => SAMPLE_PERIODS[period] >= first && SAMPLE_PERIODS[period] <= MARKET_TIMEFRAMES[timeframe]);
}

/** Share of the periods from the first candle on that have real samples (1 = none filled). */
export const coverage = (candles: MarketCandle[]): number => candles.length ? candles.filter((candle) => !candle.filled).length / candles.length : 0;

/** Requests needed for the samples of [start, end): DefiLlama allows 500 points per request across its coins. */
export function sampleRequests(coins: Coin[], start: number, end: number, sample: SamplePeriod): number {
  const perCoin = Math.floor(CHART_POINTS / Math.max(1, coins.filter((coin) => !isUsd(coin)).length));
  return Math.ceil((end - start) / SAMPLE_PERIODS[sample] / perCoin);
}

/**
 * Fetch a coin's (and the quote's) samples over [start, end): 500 points per request across both coins, in the same
 * request so their samples line up. Each request starts where the previous one's points end.
 */
export async function downloadSamples(coins: Coin[], start: number, end: number, sample: SamplePeriod,
  options: { endpoint?: string; fetcher?: typeof fetch; rateLimitWaitMs?: number } = {}, onPage?: (requests: number, reached: number) => void): Promise<{ series: Map<string, ChartSeries[]>; requests: number }> {
  const keys = coins.filter((coin) => !isUsd(coin)).map((coin) => coin.key);
  const step = SAMPLE_PERIODS[sample];
  const series = new Map<string, ChartSeries[]>(keys.map((key) => [key.toLowerCase(), []]));
  let requests = 0;
  const perCoin = Math.floor(CHART_POINTS / Math.max(1, keys.length));
  for (let from = start; from < end; from += perCoin * step) {
    const span = Math.min(perCoin, Math.ceil((end - from) / step));
    const page = await priceChart(keys, from, span, sample, options);
    requests += 1;
    for (const [key, data] of page) series.get(key)?.push(data);
    onPage?.(requests, Math.min(end, from + span * step));
  }
  return { series, requests };
}

export interface MarketCandle {
  /** Start of the candle, unix seconds (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Price samples the candle was built from; 0 for a filled period. */
  samples: number;
  /** True for a period without samples, filled with the previous close. */
  filled: boolean;
}

export interface MarketValidation {
  /** Samples DefiLlama returned per coin. */
  received: Record<string, number>;
  /** Samples outside [from, to): the last request can reach past the range end. */
  trimmed: number;
  /** Samples dropped as bad data, by reason. */
  dropped: Record<string, number>;
  /** Samples with the same timestamp as another; the first is kept. */
  duplicates: number;
  /** Coin samples with no quote sample within half a sample period, so no cross rate. */
  unmatched: number;
  /** Candle periods between the first sample and the range end without any sample. */
  missing: number;
  /** Missing periods filled forward (0 with --fill none). */
  filled: number;
  /** Candles built from fewer than half the expected samples: their high and low are less reliable. */
  lowSamples: number;
  /** Candles whose close moved more than 50% from the previous close. */
  jumps: number;
  /** Periods in the range before the first sample (no data that far back, or the coin did not exist yet). */
  leadingEmpty: number;
  /** DefiLlama's lowest confidence score (0-1) for each coin in the range. */
  confidence: Record<string, number | undefined>;
  /** Whether every period from the first candle to the end of the range is present (after filling). */
  complete: boolean;
}

interface Point { timestamp: number; price: number }

/** Valid, de-duplicated, in-range samples, oldest first; counts what was left out. */
function cleanSamples(pages: ChartSeries[], start: number, end: number, counts: { trimmed: number; duplicates: number; drop: (reason: string) => void }): Point[] {
  const byTime = new Map<number, Point>();
  for (const point of pages.flatMap((page) => page.prices)) {
    const { timestamp, price } = (point ?? {}) as { timestamp?: unknown; price?: unknown };
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || typeof price !== 'number' || !Number.isFinite(price)) { counts.drop('malformed'); continue; }
    if (price <= 0) { counts.drop('non-positive price'); continue; }
    if (timestamp < start || timestamp >= end) { counts.trimmed += 1; continue; }
    if (byTime.has(timestamp)) { counts.duplicates += 1; continue; }
    byTime.set(timestamp, { timestamp, price });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Turn samples into candles: the coin's USD price, or its cross rate with the quote coin (coin price ÷ quote price,
 * each coin sample paired with the nearest quote sample within half a sample period). Each candle opens at its first
 * sample, closes at its last, and takes the highest and lowest samples, so highs and lows between samples are missed.
 * With fill "forward", a period without samples gets the previous close; periods before the first sample are not filled.
 */
export function buildCandles(base: Coin, quote: Coin, series: Map<string, ChartSeries[]>, timeframe: MarketTimeframe, sample: SamplePeriod,
  start: number, end: number, fill: FillMode): { candles: MarketCandle[]; validation: MarketValidation } {
  const step = MARKET_TIMEFRAMES[timeframe];
  const offset = timeframe === '1w' ? WEEK_OFFSET : 0;
  const dropped: Record<string, number> = {};
  const counts = { trimmed: 0, duplicates: 0, drop: (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; } };
  const pages = (coin: Coin) => series.get(coin.key.toLowerCase()) ?? [];
  const received = Object.fromEntries([base, quote].filter((coin) => !isUsd(coin)).map((coin) => [coin.symbol, pages(coin).reduce((sum, page) => sum + page.prices.length, 0)]));
  const confidence = Object.fromEntries([base, quote].filter((coin) => !isUsd(coin)).map((coin) => {
    const scores = pages(coin).map((page) => page.confidence).filter((score): score is number => score !== undefined);
    return [coin.symbol, scores.length ? Math.min(...scores) : undefined];
  }));
  const coinPoints = cleanSamples(pages(base), start, end, counts);
  let points = coinPoints;
  let unmatched = 0;
  if (!isUsd(quote)) {
    const quotePoints = cleanSamples(pages(quote), start, end, counts);
    const tolerance = SAMPLE_PERIODS[sample] / 2;
    points = [];
    let j = 0;
    for (const point of coinPoints) {
      // Both lists are sorted: move to the quote sample nearest this one.
      while (j + 1 < quotePoints.length && Math.abs(quotePoints[j + 1]!.timestamp - point.timestamp) <= Math.abs(quotePoints[j]!.timestamp - point.timestamp)) j += 1;
      const match = quotePoints[j];
      if (match && Math.abs(match.timestamp - point.timestamp) <= tolerance) points.push({ timestamp: point.timestamp, price: point.price / match.price });
      else unmatched += 1;
    }
  }

  const real: MarketCandle[] = [];
  for (const point of points) {
    const bucket = Math.floor((point.timestamp - offset) / step) * step + offset;
    const current = real.at(-1);
    if (current?.timestamp === bucket) {
      current.high = Math.max(current.high, point.price);
      current.low = Math.min(current.low, point.price);
      current.close = point.price;
      current.samples += 1;
    } else real.push({ timestamp: bucket, open: point.price, high: point.price, low: point.price, close: point.price, samples: 1, filled: false });
  }
  const expected = Math.max(1, Math.round(step / SAMPLE_PERIODS[sample]));
  const candles: MarketCandle[] = [];
  let missing = 0;
  let jumps = 0;
  const gap = (from: number, to: number) => {
    for (let time = from; time < to; time += step) {
      missing += 1;
      if (fill === 'forward') { const close = candles.at(-1)!.close; candles.push({ timestamp: time, open: close, high: close, low: close, close, samples: 0, filled: true }); }
    }
  };
  for (const candle of real) {
    const previous = candles.at(-1);
    if (previous) {
      gap(previous.timestamp + step, candle.timestamp);
      if (Math.abs(candle.close / candles.at(-1)!.close - 1) > JUMP) jumps += 1;
    }
    candles.push(candle);
  }
  if (real.length) gap(real.at(-1)!.timestamp + step, end);
  return {
    candles,
    validation: {
      received, trimmed: counts.trimmed, dropped, duplicates: counts.duplicates, unmatched, missing, filled: fill === 'forward' ? missing : 0,
      lowSamples: real.filter((candle) => candle.samples < expected / 2).length, jumps,
      leadingEmpty: ((real[0]?.timestamp ?? end) - start) / step, confidence, complete: real.length > 0 && (fill === 'forward' || missing === 0),
    },
  };
}

export interface MarketDataset {
  source: 'defillama';
  pair: string;
  base: Coin;
  quote: Coin;
  priceUnit: string;
  /** How each price was made: the coin's USD price, or a cross rate of two USD prices. */
  method: string;
  timeframe: MarketTimeframe;
  sample: SamplePeriod;
  from: string;
  to: string;
  fill: FillMode;
  downloadedAt: string;
  requests: number;
  candles: number;
  validation: MarketValidation;
}

/** A file name that says what is inside: ETH-USD_1h_20260929-1200_20261029-1200.csv */
export function marketFileName(base: Coin, quote: Coin, timeframe: MarketTimeframe, start: number, end: number, format: CandleFormat): string {
  return `${safeName(base.symbol)}-${safeName(quote.symbol)}_${timeframe}_${fileStamp(start)}_${fileStamp(end)}.${format}`;
}

const COLUMNS: CandleColumn<MarketCandle>[] = [
  ...(['open', 'high', 'low', 'close'] as const).map((name) => ({ name, type: 'DOUBLE' as const })),
  { name: 'samples', type: 'INT32' }, { name: 'filled', type: 'BOOLEAN' },
];

/** Write candles (and, except for JSON, a .meta.json); refuses to replace files unless `force`. Returns the paths written. */
export function writeMarketData(directory: string, fileName: string, candles: MarketCandle[], dataset: MarketDataset, format: CandleFormat, force: boolean): Promise<string[]> {
  return writeRows(directory, fileName, candles, COLUMNS, dataset, format, force);
}

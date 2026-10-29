import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { CHAINS, type ChainId, type Dex, type PoolVersion } from './types.js';
import { quoteRank } from './positions-math.js';
import { GECKO_TIMEFRAMES, OHLCV_PAGE, type GeckoPool, type GeckoTerminalClient, type GeckoToken, type Timeframe } from './providers/geckoterminal.js';

/** GeckoTerminal's public API serves candles from the last 180 days only. */
export const MAX_HISTORY_DAYS = 180;
export const DEX_DATA_FORMATS = ['csv', 'json', 'jsonl', 'parquet'] as const;
export type DexFormat = typeof DEX_DATA_FORMATS[number];
export const FILL_MODES = ['forward', 'none'] as const;
export type FillMode = typeof FILL_MODES[number];
/** A close this far from the previous one (as a fraction) is reported as a jump worth checking. */
const JUMP = 0.5;

export interface Candle {
  /** Start of the candle, unix seconds (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume in the quote unit (the token prices are in, or USD). */
  volume: number;
  /** True for a period without trades, filled with the previous close and zero volume. */
  filled: boolean;
}

export interface Validation {
  /** Rows GeckoTerminal returned, across all pages. */
  received: number;
  /** Rows before the range start or after its end: the last page reaches past --from, and the newest candle may be unfinished. */
  trimmed: number;
  /** Rows dropped as bad data, by reason. */
  dropped: Record<string, number>;
  /** Rows that appeared twice; identical copies are merged. */
  duplicates: number;
  /** Duplicates whose values differed; the first row received is kept. */
  conflicts: number;
  /** Candle periods between the first and last trade with no candle. */
  missing: number;
  /** Missing periods filled forward (0 with --fill none). */
  filled: number;
  /** Candles whose close moved more than 50% from the previous close: real crashes or bad prints worth a look. */
  jumps: number;
  /** Periods in the range before the first candle (the pool did not exist or had no trades yet). */
  leadingEmpty: number;
  /** Whether every candle period from the first candle to the end of the range is present (after filling). */
  complete: boolean;
}

/** Parse a time: now, a duration ago (30d, 12h, 2w), a date (2026-10-01), a date and time (2026-10-01T12:00Z), or unix seconds. */
export function parseTime(value: string, optionName: string, now = Date.now()): number {
  const text = value.trim().toLowerCase();
  if (text === 'now') return Math.floor(now / 1000);
  const ago = /^(\d+(?:\.\d+)?)\s*(h|d|w)$/.exec(text);
  if (ago) return Math.floor(now / 1000 - Number(ago[1]) * { h: 3_600, d: 86_400, w: 604_800 }[ago[2] as 'h' | 'd' | 'w']);
  if (/^\d{9,10}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    // Dates and times without a zone are UTC, like the timestamps in the files.
    const iso = text.replace(' ', 't').toUpperCase();
    const ms = Date.parse(/T/.test(iso) && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? `${iso}Z` : iso);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new Error(`${optionName} "${value}" is not a time. Use now, a duration ago (30d, 12h, 2w), a UTC date (2026-10-01), a date and time (2026-10-01T12:00), or unix seconds.`);
}

/** The candle periods to download: [from, to) aligned to the timeframe, and whether the newest period is still open. */
export function candleRange(timeframe: Timeframe, from: number, to: number, now: number, includePartial: boolean): { start: number; end: number } {
  const step = GECKO_TIMEFRAMES[timeframe].seconds;
  if (from >= to) throw new Error('--from must be earlier than --to.');
  const oldest = now - MAX_HISTORY_DAYS * 86_400;
  if (from < oldest - 60) throw new Error(`GeckoTerminal's free API serves only the last ${MAX_HISTORY_DAYS} days; --from is ${Math.ceil((now - from) / 86_400)} days ago. Use --from ${MAX_HISTORY_DAYS}d or later.`);
  // A period counts when it starts inside the range; without --include-partial, only periods that have ended.
  const start = Math.ceil(Math.max(from, oldest) / step) * step;
  const last = includePartial ? to : Math.min(to, now - step + 1);
  const end = Math.ceil(last / step) * step;
  if (end <= start) throw new Error(`No complete ${timeframe} candle fits between --from and --to. Widen the range${includePartial ? '' : ' or add --include-partial'}.`);
  return { start, end };
}

/**
 * Check, sort and complete raw candles: drop malformed rows, merge duplicates from overlapping pages, and keep the
 * periods in [start, end). With fill "forward", a period without trades gets the previous close and zero volume:
 * in a pool, no trades means the price did not move. Periods before the first candle are not filled.
 */
export function cleanCandles(raw: unknown[][], timeframe: Timeframe, start: number, end: number, fill: FillMode): { candles: Candle[]; validation: Validation } {
  const step = GECKO_TIMEFRAMES[timeframe].seconds;
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const byTime = new Map<number, Candle>();
  let trimmed = 0;
  let duplicates = 0;
  let conflicts = 0;
  // Pages arrive newest first, so the first copy of a period is the freshest.
  for (const row of raw) {
    if (row.length < 6 || row.slice(0, 6).some((value) => typeof value !== 'number' || !Number.isFinite(value))) { drop('malformed'); continue; }
    const [timestamp, open, high, low, close, volume] = row as number[];
    if (!Number.isSafeInteger(timestamp) || timestamp % step !== 0) { drop('misaligned time'); continue; }
    if (timestamp < start || timestamp >= end) { trimmed += 1; continue; }
    if (!(open! > 0 && high! > 0 && low! > 0 && close! > 0)) { drop('non-positive price'); continue; }
    if (volume! < 0) { drop('negative volume'); continue; }
    // Allow rounding noise in the last digits of float prices.
    const slack = high! * 1e-9;
    if (high! + slack < Math.max(open!, close!, low!) || low! - slack > Math.min(open!, close!)) { drop('high/low inconsistent'); continue; }
    const candle = { timestamp: timestamp!, open: open!, high: high!, low: low!, close: close!, volume: volume!, filled: false };
    const seen = byTime.get(timestamp!);
    if (seen) {
      duplicates += 1;
      if (['open', 'high', 'low', 'close', 'volume'].some((key) => seen[key as keyof Candle] !== candle[key as keyof Candle])) conflicts += 1;
      continue;
    }
    byTime.set(timestamp!, candle);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  const candles: Candle[] = [];
  let missing = 0;
  let jumps = 0;
  for (const candle of sorted) {
    const previous = candles.at(-1);
    if (previous) {
      for (let time = previous.timestamp + step; time < candle.timestamp; time += step) {
        missing += 1;
        if (fill === 'forward') candles.push(flat(time, candles.at(-1)!.close));
      }
      if (Math.abs(candle.close / previous.close - 1) > JUMP) jumps += 1;
    }
    candles.push(candle);
  }
  // Periods after the last trade up to the end of the range had no trades either.
  const lastReal = sorted.at(-1);
  if (lastReal) {
    for (let time = lastReal.timestamp + step; time < end; time += step) {
      missing += 1;
      if (fill === 'forward') candles.push(flat(time, candles.at(-1)!.close));
    }
  }
  const leadingEmpty = sorted.length ? (sorted[0]!.timestamp - start) / step : (end - start) / step;
  return {
    candles,
    validation: { received: raw.length, trimmed, dropped, duplicates, conflicts, missing, filled: fill === 'forward' ? missing : 0, jumps, leadingEmpty, complete: sorted.length > 0 && (fill === 'forward' || missing === 0) },
  };
}

const flat = (timestamp: number, price: number): Candle => ({ timestamp, open: price, high: price, low: price, close: price, volume: 0, filled: true });

/**
 * Download every candle in [start, end), newest page first. Each request returns up to 1,000 candles ending at
 * `before`; the next request ends at the oldest candle seen, until the range start, an empty page, or no progress.
 * A candle starting exactly at `before` counts only trades up to that second, so on later pages it is a partial
 * copy of one already received complete, and is skipped.
 */
export async function downloadCandles(client: GeckoTerminalClient, pool: GeckoPool, timeframe: Timeframe, start: number, end: number,
  price: { token: string; currency: 'token' | 'usd' }, onPage?: (pages: number, oldest: number) => void): Promise<{ raw: unknown[][]; requests: number }> {
  const raw: unknown[][] = [];
  let before = end - 1;
  let requests = 0;
  for (;;) {
    let page: unknown[][];
    try {
      page = await client.ohlcv(pool.chainId, pool.address, timeframe, { before, ...price, limit: OHLCV_PAGE });
    } catch (error) {
      if (/HTTP 401/.test((error as Error).message)) throw new Error(`GeckoTerminal refused candles before ${isoTime(before)}: its free API serves only the last ${MAX_HISTORY_DAYS} days.`);
      throw error;
    }
    raw.push(...(requests ? page.filter((row) => row[0] !== before) : page));
    requests += 1;
    const times = page.map((row) => row[0]).filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
    if (!times.length) break;
    const oldest = Math.min(...times);
    onPage?.(requests, oldest);
    if (oldest <= start || oldest >= before) break;
    before = oldest;
  }
  return { raw, requests };
}

/** Native coins also match their wrapped token (ETH and WETH, SOL and WSOL). */
const symbolAliases = (symbol: string): string[] => symbol === 'eth' || symbol === 'weth' ? ['eth', 'weth'] : symbol === 'sol' || symbol === 'wsol' ? ['sol', 'wsol'] : [symbol];
const isAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/i.test(value) || /^[1-9a-hj-np-za-km-z]{32,44}$/i.test(value) && !/^[a-z]+$/i.test(value);
export const tokenMatches = (token: GeckoToken, query: string): boolean => token.address.toLowerCase() === query.toLowerCase() || symbolAliases(query.toLowerCase()).includes(token.symbol.toLowerCase());

export interface PoolQuery { pair: [string, string]; dexes: Dex[]; versions: PoolVersion[]; feeTier?: number }

/**
 * The pools on one network that trade the pair, deepest first. A token given by address is looked up through that
 * token's pools; symbols through GeckoTerminal's search, reading up to three pages until a match appears.
 */
export async function findPools(client: GeckoTerminalClient, chainId: ChainId, query: PoolQuery): Promise<GeckoPool[]> {
  const [a, b] = query.pair;
  const byAddress = [a, b].find(isAddress);
  const matches = (pool: GeckoPool) => pool.dex !== undefined && query.dexes.includes(pool.dex) && pool.version !== undefined && query.versions.includes(pool.version)
    && (query.feeTier === undefined || pool.feeTier === query.feeTier)
    && ((tokenMatches(pool.base, a) && tokenMatches(pool.quote, b)) || (tokenMatches(pool.base, b) && tokenMatches(pool.quote, a)));
  const found = new Map<string, GeckoPool>();
  for (let page = 1; page <= 3; page += 1) {
    const pools = byAddress ? await client.tokenPools(chainId, byAddress, page) : await client.searchPools(chainId, `${a} ${b}`, page);
    for (const pool of pools.filter(matches)) found.set(pool.address.toLowerCase(), pool);
    if (found.size || pools.length < 20) break;
  }
  return [...found.values()].sort((x, y) => (y.tvlUsd ?? 0) - (x.tvlUsd ?? 0));
}

/**
 * Which token to price and in what. "auto" quotes in the more money-like token, as positions list does (stablecoin,
 * then the native coin, then BTC; otherwise GeckoTerminal's quote token); "usd" prices the other token in US dollars;
 * a symbol or address names the quote token.
 */
export function priceUnit(pool: GeckoPool, quote: string): { priced: GeckoToken; quote?: GeckoToken; currency: 'token' | 'usd'; label: string } {
  const choice = quote.trim().toLowerCase();
  const [first, second] = [pool.base, pool.quote];
  const pick = (quoteToken: GeckoToken) => quoteToken === first ? { priced: second, quote: first } : { priced: first, quote: second };
  if (choice === 'usd') {
    const { priced } = pick(quoteRank(first.symbol) > quoteRank(second.symbol) ? first : second);
    return { priced, currency: 'usd', label: `USD per ${priced.symbol}` };
  }
  let tokens: { priced: GeckoToken; quote: GeckoToken };
  if (choice === 'auto') tokens = pick(quoteRank(first.symbol) > quoteRank(second.symbol) ? first : second);
  else if (tokenMatches(first, choice)) tokens = pick(first);
  else if (tokenMatches(second, choice)) tokens = pick(second);
  else throw new Error(`--quote "${quote}" is not a token of ${pool.name}. Use auto, usd, ${first.symbol} or ${second.symbol}.`);
  return { ...tokens, currency: 'token', label: `${tokens.quote.symbol} per ${tokens.priced.symbol}` };
}

export interface DexDataset {
  source: 'geckoterminal';
  pool: { chain: string; chainId: ChainId; dex?: Dex; dexId: string; version?: PoolVersion; address: string; name: string; feeTier?: number; tvlUsd?: number; createdAt?: string };
  pair: string;
  priceUnit: string;
  pricedToken: GeckoToken;
  quoteToken?: GeckoToken;
  volumeUnit: string;
  timeframe: Timeframe;
  from: string;
  to: string;
  fill: FillMode;
  downloadedAt: string;
  requests: number;
  candles: number;
  validation: Validation;
}

export const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const stamp = (seconds: number) => isoTime(seconds).slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const safe = (text: string) => text.replace(/[^A-Za-z0-9.]+/g, '').slice(0, 20) || 'token';

/** A file name that says what is inside: WETH-USDC_base_uniswap-v3-0.05_1h_20260929-0000_20261029-0000.csv */
export function datasetFileName(dataset: Omit<DexDataset, 'candles' | 'validation' | 'requests' | 'downloadedAt'>, start: number, end: number, format: DexFormat): string {
  const { pool } = dataset;
  const quote = dataset.quoteToken?.symbol ?? 'USD';
  const kind = [pool.dex ?? safe(pool.dexId), pool.version, pool.feeTier === undefined ? undefined : String(pool.feeTier / 10_000)].filter(Boolean).join('-');
  // Several pools can share a pair and tier (v4 hooks, Aerodrome deployments); the address prefix keeps them apart.
  return `${safe(dataset.pricedToken.symbol)}-${safe(quote)}_${CHAINS[pool.chainId].slug}_${kind}_${pool.address.slice(0, 8)}_${dataset.timeframe}_${stamp(start)}_${stamp(end)}.${format}`;
}

const COLUMNS = ['time', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'filled'] as const;
const row = (candle: Candle) => ({ time: isoTime(candle.timestamp), ...candle });

/** Encode candles in a format. JSON holds the metadata too; other formats get it in a .meta.json file beside them (Parquet also in its footer). */
export function encodeCandles(candles: Candle[], dataset: DexDataset, format: DexFormat): Uint8Array | string {
  if (format === 'csv') return `${COLUMNS.join(',')}\n${candles.map((candle) => COLUMNS.map((column) => String(row(candle)[column])).join(',')).join('\n')}${candles.length ? '\n' : ''}`;
  if (format === 'jsonl') return candles.map((candle) => JSON.stringify(row(candle))).join('\n') + (candles.length ? '\n' : '');
  if (format === 'json') return `${JSON.stringify({ meta: dataset, candles: candles.map(row) }, null, 2)}\n`;
  return new Uint8Array(parquetWriteBuffer({
    columnData: [
      { name: 'time', data: candles.map((candle) => new Date(candle.timestamp * 1000)), type: 'TIMESTAMP' },
      { name: 'timestamp', data: candles.map((candle) => BigInt(candle.timestamp)), type: 'INT64' },
      ...(['open', 'high', 'low', 'close', 'volume'] as const).map((name) => ({ name, data: candles.map((candle) => candle[name]), type: 'DOUBLE' as const })),
      { name: 'filled', data: candles.map((candle) => candle.filled), type: 'BOOLEAN' },
    ],
    kvMetadata: [{ key: 'defi-tool', value: JSON.stringify(dataset) }],
  }));
}

/** Write the data file (and, except for JSON, its .meta.json); refuses to replace files unless `force`. Returns the paths written. */
export async function writeDataset(directory: string, fileName: string, candles: Candle[], dataset: DexDataset, format: DexFormat, force: boolean): Promise<string[]> {
  const path = join(directory, fileName);
  const metaPath = `${path}.meta.json`;
  const paths = format === 'json' ? [path] : [path, metaPath];
  const existing = paths.find((item) => existsSync(item));
  if (existing && !force) throw new Error(`${existing} already exists. Add --force to replace it, or choose another --out-dir.`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, encodeCandles(candles, dataset, format));
  if (format !== 'json') await writeFile(metaPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return paths;
}

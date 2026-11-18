import { parseChains } from '../config.js';
import { GECKO_TIMEFRAMES, GeckoTerminalClient, type GeckoPool, type Timeframe } from '../providers/geckoterminal.js';
import { feeTierFromPercent } from '../providers/http.js';
import { MAX_HISTORY_DAYS, priceUnit, resolvePool, tokenMatches } from '../dex-data.js';
import { TickerFeed, tickerJson, type Ticker } from '../dex-ticker.js';
import { cachedPools, listCachedFiles, loadShowData, type SeriesKey } from '../dex-cache.js';
import { showStats, type ShowView } from '../dex-show.js';
import { alignRange, isoTime, parseTime } from '../candle-files.js';
import { CHAINS, type AppConfig, type ChainId, type Dex, type PoolVersion } from '../types.js';
import type { Report } from './wallets.js';

// Pool choice for dex-data show and dex-ticker, and the chart data for dex-data show, shared with the dashboard.

export interface PoolChoice {
  /** A pair such as WETH/USDC, or a pool address with `pool`. */
  pair?: string;
  pool?: string;
  chain?: string;
  dex: Dex[];
  protocol: PoolVersion[];
  /** Fee tier in percent, e.g. 0.05. */
  fee?: string;
}

export function parseFeeTier(fee: string | undefined): number | undefined {
  const feeTier = fee === undefined ? undefined : feeTierFromPercent(`${fee.replace(/%$/, '')}%`);
  if (fee !== undefined && feeTier === undefined) throw new Error(`--fee "${fee}" is not a fee tier. Use a percentage such as 0.01, 0.05, 0.3 or 1.`);
  return feeTier;
}

export function checkChoice(choice: PoolChoice, command: string): void {
  if (choice.pair && choice.pool) throw new Error('Give either a pair or --pool, not both.');
  if (!choice.pair && !choice.pool) throw new Error(`Name a pair, e.g. defi-tool ${command} WETH/USDC --chain base, or use --pool.`);
}

/** The deepest pool matching the choice (or the named pool), from GeckoTerminal. */
export async function findPool(client: GeckoTerminalClient, choice: PoolChoice, config: AppConfig, options: { onSearch?: (chain: ChainId) => void; onError?: (chain: ChainId, error: Error) => void } = {}): Promise<GeckoPool> {
  const chains = parseChains(choice.chain) ?? config.chains;
  if (choice.pool) {
    if (chains.length !== 1) throw new Error('--pool needs exactly one network, e.g. --chain base.');
    return client.pool(chains[0]!, choice.pool.trim());
  }
  return (await resolvePool(client, choice.pair!, chains, { dexes: choice.dex, versions: choice.protocol, feeTier: parseFeeTier(choice.fee) }, options)).pool;
}

export interface PoolChartRequest extends PoolChoice {
  quote: string;
  timeframe: Timeframe;
  from?: string;
  to: string;
  dataDir: string;
  offline?: boolean;
  refresh?: boolean;
}

export interface PoolMeta {
  name: string; dex?: Dex; dexId: string; version?: PoolVersion; feeTier?: number; chainId: ChainId; address: string;
  priceUnit: string; volumeUnit: string; pricedSymbol: string; quoteSymbol: string;
}

export interface PoolChart {
  view: ShowView;
  meta: PoolMeta;
  range: { start: number; end: number };
  ticker?: Ticker;
  tickerNote?: string;
}

/** dex-data show: the pool's candles from the cache first, missing stretches downloaded, plus the live ticker. */
export async function loadPoolChart(request: PoolChartRequest, { config, report, progress = () => {} }: { config: AppConfig; report: Report; progress?: (text: string) => void }): Promise<PoolChart> {
  checkChoice(request, 'dex-data show');
  if (request.offline && request.refresh) throw new Error('--refresh downloads again, so it cannot be combined with --offline.');
  const explicitChains = parseChains(request.chain);
  const feeTier = parseFeeTier(request.fee);
  const client = request.offline ? undefined : new GeckoTerminalClient({ endpoint: process.env.DEFI_TOOL_GECKOTERMINAL_URL });

  // The pool and price unit: searched online, or found among cached files offline (or when the search fails).
  let pool: GeckoPool | undefined;
  let unit: ReturnType<typeof priceUnit> | undefined;
  let note: string | undefined;
  if (client) {
    try {
      if (!request.pool) progress(`Finding ${request.pair}…`);
      pool = await findPool(client, request, config, { onSearch: (chain) => progress(`Finding ${request.pair} on ${CHAINS[chain].name}…`) });
      unit = priceUnit(pool, request.quote);
    } catch (error) {
      const message = (error as Error).message;
      if (/^No .* pool on /.test(message) || /is not a token of/.test(message)) throw error;
      note = message;
      progress('');
      report(`Could not reach GeckoTerminal (${note}); using the cache only.`);
    }
  }
  let key: SeriesKey;
  let meta: PoolMeta;
  if (pool && unit) {
    key = { chainId: pool.chainId, address: pool.address, priced: unit.priced.address, quote: unit.quote?.address };
    meta = { name: pool.name, dex: pool.dex, dexId: pool.dexId, version: pool.version, feeTier: pool.feeTier, chainId: pool.chainId, address: pool.address, priceUnit: unit.label, volumeUnit: unit.quote?.symbol ?? 'USD', pricedSymbol: unit.priced.symbol, quoteSymbol: unit.quote?.symbol ?? 'USD' };
  } else {
    const quote = request.quote.trim().toLowerCase();
    const pair = request.pair?.split('/').map((part) => part.trim());
    const match = (await cachedPools(request.dataDir)).find(({ meta: item }) =>
      (!explicitChains || explicitChains.includes(item.pool.chainId)) && (request.pool
        ? item.pool.address.toLowerCase() === request.pool.trim().toLowerCase()
        : pair?.length === 2 && item.quoteToken && ((tokenMatches(item.pricedToken, pair[0]!) && tokenMatches(item.quoteToken, pair[1]!)) || (tokenMatches(item.pricedToken, pair[1]!) && tokenMatches(item.quoteToken, pair[0]!)))
          && (item.pool.dex === undefined || request.dex.includes(item.pool.dex)) && (item.pool.version === undefined || request.protocol.includes(item.pool.version))
          && (feeTier === undefined || item.pool.feeTier === feeTier))
      && (quote === 'usd' ? !item.quoteToken : quote === 'auto' ? Boolean(item.quoteToken) : Boolean(item.quoteToken && tokenMatches(item.quoteToken, quote))));
    if (!match) throw new Error(`No cached download in ${request.dataDir} matches ${request.pair ?? request.pool}${request.offline ? '' : ', and GeckoTerminal could not be reached'}. Run defi-tool dex-data download first, or drop --offline.`);
    const item = match.meta;
    key = { chainId: item.pool.chainId, address: item.pool.address, priced: item.pricedToken.address, quote: item.quoteToken?.address };
    meta = { name: item.pool.name, dex: item.pool.dex, dexId: item.pool.dexId, version: item.pool.version, feeTier: item.pool.feeTier, chainId: item.pool.chainId, address: item.pool.address, priceUnit: item.priceUnit, volumeUnit: item.volumeUnit, pricedSymbol: item.pricedToken.symbol, quoteSymbol: item.quoteToken?.symbol ?? 'USD' };
  }

  // The range: all time by default, which is the earliest cached candle or GeckoTerminal's 180 days, whichever is older.
  const step = GECKO_TIMEFRAMES[request.timeframe].seconds;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  let from: number;
  if (request.from !== undefined && request.from !== '') from = parseTime(request.from, '--from', nowMs);
  else {
    const cached = (await listCachedFiles(request.dataDir)).filter((file) => file.meta.pool.chainId === key.chainId && file.meta.pool.address.toLowerCase() === key.address.toLowerCase());
    from = Math.min(now - MAX_HISTORY_DAYS * 86_400 + step, ...cached.map((file) => Date.parse(file.meta.from) / 1000));
  }
  const range = alignRange(step, request.timeframe, from, parseTime(request.to, '--to', nowMs), now, false);
  const pair = `${meta.pricedSymbol}/${meta.quoteSymbol}`;
  const data = await loadShowData({ directory: request.dataDir, key, timeframe: request.timeframe, start: range.start, end: range.end, now, offline: !client || !pool, refresh: Boolean(request.refresh), client, pool, unit, pair, onProgress: progress });
  let ticker: Ticker | undefined;
  let tickerNote = request.offline ? 'offline' : note ? 'GeckoTerminal could not be reached' : undefined;
  if (client && pool) {
    progress('Reading the live ticker…');
    try { ticker = await new TickerFeed(client, pool, request.quote).read(); } catch (error) { tickerNote = (error as Error).message.replace(/\.$/, ''); }
  }
  progress('');
  const view: ShowView = {
    pair, poolLabel: poolLabel(meta), chainId: meta.chainId, address: meta.address, priceUnit: meta.priceUnit, volumeUnit: meta.volumeUnit, timeframe: request.timeframe, step,
    candles: data.candles, stats: showStats(data.candles, step), ticker, tickerNote,
    sources: { cached: data.cached.map((file) => file.path), downloaded: data.downloaded, unavailable: data.unavailable, requests: data.requests },
  };
  return { view, meta, range, ticker, tickerNote };
}

/** "Uniswap v3 0.05%". */
export function poolLabel(meta: { dex?: Dex; dexId: string; version?: PoolVersion; feeTier?: number }): string {
  return `${meta.dex ? meta.dex[0]!.toUpperCase() + meta.dex.slice(1) : meta.dexId}${meta.version ? ` ${meta.version}` : ''}${meta.feeTier === undefined ? '' : ` ${meta.feeTier / 10_000}%`}`;
}

/** The JSON shape of dex-data show --json. */
export function poolChartJson(chart: PoolChart): object {
  const { view, meta, range, ticker, tickerNote } = chart;
  return {
    pair: view.pair, pool: { chainId: meta.chainId, chain: CHAINS[meta.chainId].slug, address: meta.address, name: meta.name, dex: meta.dex, version: meta.version, feeTier: meta.feeTier },
    priceUnit: meta.priceUnit, volumeUnit: meta.volumeUnit, timeframe: view.timeframe, from: isoTime(range.start), to: isoTime(range.end),
    stats: view.stats, ticker: ticker && tickerJson(ticker), tickerNote, sources: view.sources,
    candles: view.candles.map((candle) => ({ time: isoTime(candle.timestamp), ...candle })),
  };
}

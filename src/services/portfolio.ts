import { parseChains } from '../config.js';
import type { Store } from '../storage.js';
import { RpcProvider } from '../providers/rpc.js';
import { RevertClient } from '../providers/revert.js';
import { loadPortfolio, splitPositions, type PositionSource, type WalletGroup } from '../positions.js';
import { GECKO_TIMEFRAMES, GeckoTerminalClient, type GeckoPool, type Timeframe } from '../providers/geckoterminal.js';
import { type Candle, priceUnit } from '../dex-data.js';
import { currentPrice } from '../dex-ticker.js';
import { cachedPools, loadShowData, type SeriesKey } from '../dex-cache.js';
import { analyzePositionDetail, pickPosition, type PositionDetail } from '../position-detail.js';
import { invertPrice } from '../positions-math.js';
import { alignRange, isoTime } from '../candle-files.js';
import type { AppConfig, LpPosition } from '../types.js';
import { groupLabel, walletGroups, type Report } from './wallets.js';

// positions list and positions detail as data functions, shared by the CLI and the dashboard.

export interface WalletSelection {
  /** Saved wallet names, comma-separated, or all. */
  wallet?: string;
  /** 0x addresses, comma-separated. */
  walletAddr?: string;
  /** --chain as typed. */
  chain?: string;
  source: PositionSource;
}

export interface PortfolioDeps {
  config: AppConfig;
  store: Store;
  report: Report;
  /** Leave out the "Using the default wallet" note. */
  quiet?: boolean;
}

export interface PortfolioView {
  groups: WalletGroup[];
  /** "main (0x902e…3f00) on all networks", one per wallet group. */
  scope: string[];
  /** Where the data came from, for the header line. */
  sourceLabel: string;
  active: LpPosition[];
  past: LpPosition[];
  observedAt: string;
}

const noWallets = 'No wallets to read. Save one with defi-tool wallet add 0xYourWallet --chain eth, or pass --wallet-addr 0xYourWallet.';

function clients(config: AppConfig) {
  return { revert: new RevertClient({ endpoint: process.env.DEFI_TOOL_REVERT_URL }), rpc: new RpcProvider(config.rpcUrls), pricesUrl: process.env.DEFI_TOOL_PRICES_URL };
}

/** Every open and closed position of the selected wallets; open ones are saved as snapshots, as positions list does. */
export async function listPortfolio(selection: WalletSelection, { config, store, report, quiet }: PortfolioDeps): Promise<PortfolioView> {
  const groups = walletGroups(selection.wallet, selection.walletAddr, parseChains(selection.chain), config, store, { report, quiet });
  if (!groups.length) throw new Error(noWallets);
  const result = await loadPortfolio(groups, selection.source, clients(config), report);
  store.savePositions(result.positions.filter((position) => position.active).map((position) => ({
    id: position.id, wallet: position.wallet, poolId: position.pool ?? '', chainId: position.chainId, protocol: position.protocol, lowerTick: position.tickLower, upperTick: position.tickUpper,
    currentTick: position.currentTick, liquidity: position.liquidity, valueUsd: position.valueUsd, source: position.source,
  })));
  const { active, past } = splitPositions(result.positions);
  const sources = new Set(result.positions.map((position) => position.source));
  return {
    groups, scope: groups.map(groupLabel), active, past, observedAt: new Date().toISOString(),
    sourceLabel: sources.has('rpc') ? (sources.has('revert') ? 'Revert Finance and on-chain RPC (no API key)' : 'on-chain RPC and DefiLlama prices (no API key)') : 'Revert Finance (no API key)',
  };
}

export interface DetailRequest extends WalletSelection {
  /** NFT ID (#123 or 123) or a row number of positions list. */
  reference: string;
  past?: boolean;
  timeframe: 'auto' | Timeframe;
  dataDir: string;
  offline?: boolean;
}

export interface DetailResult {
  position: LpPosition;
  /** "position #123" or "row 2 of the open positions". */
  how: string;
  analysis: PositionDetail;
  candles: Candle[];
  timeframe?: Timeframe;
  step: number;
  dataNote?: string;
}

/** One position analysed in depth, with the pool's candles from the cache first (positions detail). */
export async function positionDetailData(request: DetailRequest, deps: PortfolioDeps & { progress?: (text: string) => void }): Promise<DetailResult> {
  const progress = deps.progress ?? (() => {});
  const groups = walletGroups(request.wallet, request.walletAddr, parseChains(request.chain), deps.config, deps.store, { report: deps.report, quiet: deps.quiet });
  if (!groups.length) throw new Error(noWallets);
  progress('Reading positions…');
  const portfolio = await loadPortfolio(groups, request.source, clients(deps.config), (message) => { progress(''); deps.report(message); }, { events: true });
  const { position, how } = pickPosition(portfolio.positions, request.reference, { past: request.past, ordered: splitPositions(portfolio.positions) });

  // The pool's candles in the position's price unit, from the cache first, for the chart and the time-in-range figures.
  const now = Math.floor(Date.now() / 1000);
  const opened = position.openedAt ? Date.parse(position.openedAt) / 1000 : position.events?.[0]?.timestamp;
  const closed = position.closedAt ? Date.parse(position.closedAt) / 1000 : undefined;
  const quoteToken = invertPrice(position.token0.symbol, position.token1.symbol) ? position.token0 : position.token1;
  let candles: Candle[] = [];
  let timeframe: Timeframe | undefined;
  let livePrice: number | undefined;
  let dataNote: string | undefined;
  if (!position.pool) dataNote = 'the position has no pool address';
  else {
    const held = ((closed ?? now) - (opened ?? now - 7 * 86_400));
    const pad = Math.max(held * 0.3, 86_400);
    const from = (opened ?? now - 7 * 86_400) - pad;
    const to = closed === undefined ? now : Math.min(now, closed + pad);
    const span = to - from;
    timeframe = request.timeframe !== 'auto' ? request.timeframe : span <= 4 * 86_400 ? '15m' : span <= 30 * 86_400 ? '1h' : span <= 120 * 86_400 ? '4h' : '1d';
    const step = GECKO_TIMEFRAMES[timeframe].seconds;
    const client = request.offline ? undefined : new GeckoTerminalClient({ endpoint: process.env.DEFI_TOOL_GECKOTERMINAL_URL });
    let pool: GeckoPool | undefined;
    let unit: ReturnType<typeof priceUnit> | undefined;
    let key: SeriesKey | undefined;
    try {
      if (client) {
        progress('Reading the pool from GeckoTerminal…');
        pool = await client.pool(position.chainId, position.pool);
        unit = priceUnit(pool, quoteToken.address);
        livePrice = currentPrice(pool, unit);
        key = { chainId: pool.chainId, address: pool.address, priced: unit.priced.address, quote: unit.quote?.address };
      }
    } catch (error) { dataNote = `GeckoTerminal: ${(error as Error).message.replace(/\.$/, '')}`; }
    if (!key) {
      const cached = (await cachedPools(request.dataDir)).find(({ meta }) => meta.pool.chainId === position.chainId && meta.pool.address.toLowerCase() === position.pool!.toLowerCase() && meta.quoteToken?.address.toLowerCase() === quoteToken.address.toLowerCase());
      if (cached) key = { chainId: cached.meta.pool.chainId, address: cached.meta.pool.address, priced: cached.meta.pricedToken.address, quote: cached.meta.quoteToken?.address };
      else dataNote ??= `no cached candles for this pool in ${request.dataDir}`;
    }
    if (key) {
      const range = alignRange(step, timeframe, from, to, now, false);
      const data = await loadShowData({ directory: request.dataDir, key, timeframe, start: range.start, end: range.end, now, offline: !pool, refresh: false, client, pool, unit, pair: position.token0.symbol + '/' + position.token1.symbol, onProgress: progress });
      candles = data.candles;
      if (!candles.length) dataNote = 'no candles for the time the position was open';
      else if (data.unavailable.length) dataNote = `Candles from ${isoTime(data.unavailable[0]![0]).slice(0, 10)} are missing: older than GeckoTerminal's 180 days and not in the cache, so time in range covers less than the whole position.`;
    }
  }
  progress('');
  const step = timeframe ? GECKO_TIMEFRAMES[timeframe].seconds : 3600;
  const analysis = analyzePositionDetail({ position, candles, timeframe, step: timeframe && step, livePrice, now });
  return { position, how, analysis, candles, timeframe, step, dataNote };
}

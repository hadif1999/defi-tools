import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { parseDexes, parsePoolSorts, parsePoolVersions, parseChains, DEFAULT_API_URL } from '../config.js';
import { FILTER_COLUMNS, parseFilters, type PoolFilter } from '../filters.js';
import type { Store } from '../storage.js';
import { RpcProvider } from '../providers/rpc.js';
import { walletBalances, type WalletBalance } from '../providers/balances.js';
import { GECKO_TIMEFRAMES, type GeckoTerminalClient, type Timeframe } from '../providers/geckoterminal.js';
import { CREATE_CHAINS } from '../providers/tokens.js';
import { tickerJson, TickerFeed } from '../dex-ticker.js';
import { listCachedFiles } from '../dex-cache.js';
import { buildChartHtml } from '../html-chart.js';
import { buildPositionHtml } from '../position-html.js';
import { mmCommand } from '../output.js';
import { MARKET_TIMEFRAMES, SAMPLE_PERIODS, type MarketTimeframe, type SamplePeriod } from '../market-data.js';
import { CANDLE_FORMATS, FILL_MODES, isoTime } from '../candle-files.js';
import { ACTIVITY_KINDS, CHAINS, DEXES, POOL_SORTS, POOL_VERSIONS, SOLANA, isEvmChain, type AppConfig, type ChainId, type LpPosition } from '../types.js';
import { addWallet, deleteWallet, editWallet, setDefaultWallet, EVM_CHAINS } from '../services/wallets.js';
import { searchPools, type PoolMode } from '../services/pools.js';
import { listPortfolio, positionDetailData, type PortfolioView } from '../services/portfolio.js';
import { checkPositions } from '../services/alerts.js';
import { findPool, loadPoolChart, poolChartJson, type PoolChoice } from '../services/pool-chart.js';
import { downloadDex, marketData } from '../services/downloads.js';
import { buildPlan, loadHistory } from '../services/activity.js';
import { TTL, type TtlCache } from './cache.js';
import { jobSummary, type Jobs } from './jobs.js';
import { tickerKey, type EventHub } from './events.js';
import { HttpError, parse, q, type Context, type Router } from './http.js';
import { pageCsp, withNonce } from './security.js';

// The dashboard's JSON API. Each route calls the same service the matching CLI command uses, so the numbers, rules and
// messages match the terminal. Responses are { data, notes, cachedAt?, cached? }; notes are what the CLI writes to stderr.

export interface DashboardState {
  config: AppConfig;
  store: Store;
  cache: TtlCache;
  jobs: Jobs;
  hub: EventHub;
  gecko?: GeckoTerminalClient;
  version: string;
  startedAt: number;
  options: { dataDir: string; marketDir: string; readOnly: boolean; offline: boolean; refreshMs: number; host: string; port: number };
}

type Notes = { notes: string[]; report: (message: string) => void };
const notes = (): Notes => {
  const list: string[] = [];
  return { notes: list, report: (message) => { const text = message.trim(); if (text && !list.includes(text)) list.push(text); } };
};

/** Parse a comma-separated option with the CLI's own parser, as a 400 when it fails. */
const option = <T>(value: string | undefined, parser: (text: string) => T, fallback: T): T => {
  if (value === undefined) return fallback;
  try { return parser(value); } catch (error) { throw new HttpError(400, (error as Error).message, 'invalid_input'); }
};

const cacheKey = (prefix: string, value: unknown) => `${prefix}:${JSON.stringify(value)}`;

const walletQuery = z.object({ wallet: q.list, walletAddr: q.list, chain: q.list, source: z.enum(['auto', 'revert', 'rpc']).default('auto'), refresh: q.bool });
const poolChoice = { pair: q.text, pool: q.text, chain: q.list, dex: q.list, protocol: q.list, fee: q.text };
const chartQuery = z.object({
  ...poolChoice, quote: z.string().trim().max(80).default('auto'), timeframe: z.enum(Object.keys(GECKO_TIMEFRAMES) as [Timeframe, ...Timeframe[]]).default('1h'),
  from: q.text, to: z.string().trim().max(40).default('now'), refresh: q.bool, offline: q.bool,
});
const detailQuery = walletQuery.extend({
  ref: z.string().trim().min(1, 'ref is required: a position ID (#123) or a row number').max(80), past: q.bool,
  timeframe: z.enum(['auto', '15m', '1h', '4h', '1d']).default('auto'),
});

function choice(query: { pair?: string; pool?: string; chain?: string; dex?: string; protocol?: string; fee?: string }, defaults: { dex: string; protocol: string }): PoolChoice {
  return {
    pair: query.pair, pool: query.pool, chain: query.chain, fee: query.fee,
    dex: option(query.dex ?? defaults.dex, parseDexes, []), protocol: option(query.protocol ?? defaults.protocol, parsePoolVersions, []),
  };
}

/** Totals for the overview: what is open, in or out of range, and what it earned. */
export function summarize(view: PortfolioView): object {
  const sum = (items: LpPosition[], pick: (position: LpPosition) => number | undefined) => {
    const values = items.map(pick).filter((value): value is number => value !== undefined && Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const all = [...view.active, ...view.past];
  const byChain = new Map<string, number>();
  const byPool = new Map<string, number>();
  for (const position of view.active) {
    const chain = CHAINS[position.chainId].name;
    byChain.set(chain, (byChain.get(chain) ?? 0) + (position.valueUsd ?? 0));
    const pool = `${position.token0.symbol}/${position.token1.symbol}${position.feeTier === undefined ? '' : ` ${position.feeTier / 10_000}%`}`;
    byPool.set(pool, (byPool.get(pool) ?? 0) + (position.valueUsd ?? 0));
  }
  const entries = (map: Map<string, number>) => [...map].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return {
    open: view.active.length, closed: view.past.length,
    inRange: view.active.filter((position) => position.inRange === true).length,
    outOfRange: view.active.filter((position) => position.inRange === false).length,
    unknownRange: view.active.filter((position) => position.inRange === undefined).length,
    valueUsd: sum(view.active, (position) => position.valueUsd),
    uncollectedFeesUsd: sum(view.active, (position) => position.uncollectedFeesUsd),
    feesEarnedUsd: sum(all, (position) => position.feesEarnedUsd),
    pnlUsd: sum(all, (position) => position.pnlUsd),
    openPnlUsd: sum(view.active, (position) => position.pnlUsd),
    ilUsd: sum(all, (position) => position.ilUsd),
    gasUsd: sum(all, (position) => position.gasUsd),
    depositedUsd: sum(view.active, (position) => position.depositedUsd),
    byChain: entries(byChain), byPool: entries(byPool),
  };
}

const MARKET_META = '.meta.json';

/** Saved market-data downloads (DefiLlama), by their .meta.json files. */
async function marketFiles(directory: string): Promise<Array<{ name: string; meta: Record<string, unknown> }>> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const found: Array<{ name: string; meta: Record<string, unknown> }> = [];
  for (const name of names.filter((item) => item.endsWith(MARKET_META))) {
    const data = name.slice(0, -MARKET_META.length);
    if (!names.includes(data)) continue;
    try {
      const meta = JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
      if (meta.source === 'defillama') found.push({ name: data, meta });
    } catch { /* not a market-data file */ }
  }
  return found;
}

const fileInfo = async (path: string) => { try { const info = await stat(path); return { size: info.size, modifiedAt: info.mtime.toISOString() }; } catch { return {}; } };

export function registerApi(router: Router, state: DashboardState): void {
  const { config, store, cache, jobs, hub } = state;
  const deps = (n: Notes) => ({ config, store, report: n.report, quiet: true });
  const rpc = () => new RpcProvider(config.rpcUrls);
  const writable = () => { if (state.options.readOnly) throw new HttpError(403, 'The dashboard runs with --read-only; changes are turned off.', 'read_only'); };

  // ---------- meta
  router.get('/api/health', () => ({
    ok: true, version: state.version, uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    events: hub.stats, jobsRunning: jobs.running, cacheEntries: cache.size,
  }));

  router.get('/api/meta', () => {
    const defaults = store.defaultWallet();
    return {
      data: {
        version: state.version,
        chains: Object.entries(CHAINS).map(([id, chain]) => ({ id: Number(id), name: chain.name, slug: chain.slug, aliases: chain.aliases, dexes: chain.dexes, native: chain.native, evm: isEvmChain(Number(id) as ChainId) })),
        dexes: DEXES, poolVersions: POOL_VERSIONS, poolSorts: POOL_SORTS, filterColumns: FILTER_COLUMNS.split(', '), activityKinds: ACTIVITY_KINDS,
        timeframes: Object.keys(GECKO_TIMEFRAMES), marketTimeframes: Object.keys(MARKET_TIMEFRAMES), samplePeriods: Object.keys(SAMPLE_PERIODS),
        candleFormats: CANDLE_FORMATS, fillModes: FILL_MODES, createChains: CREATE_CHAINS.map((chain) => CHAINS[chain].slug),
        config: {
          chains: config.chains.map((chain) => CHAINS[chain].slug), databasePath: config.databasePath,
          rpcConfigured: (Object.keys(config.rpcUrls).map(Number) as ChainId[]).filter((chain) => chain in CHAINS).map((chain) => CHAINS[chain].slug),
          alchemy: Boolean(config.alchemyApiKey), customProvider: config.apiUrl !== DEFAULT_API_URL, initWallets: config.wallets.length,
          saturationThresholdPct: config.saturationThresholdPct,
        },
        dashboard: { readOnly: state.options.readOnly, offline: state.options.offline, dataDir: state.options.dataDir, marketDir: state.options.marketDir, refreshMs: state.options.refreshMs },
        defaultWallet: defaults ? { name: defaults.wallet.name, chosen: defaults.chosen } : undefined,
      },
    };
  });

  // ---------- wallets
  router.get('/api/wallets', async (ctx) => {
    const query = parse(z.object({ balances: q.bool, refresh: q.bool }), ctx.query);
    const wallets = store.wallets();
    const defaults = store.defaultWallet();
    let balances: Map<string, WalletBalance | Error> | undefined;
    let cachedAt: string | undefined;
    if (query.balances && wallets.length) {
      const key = cacheKey('balances', wallets.map((wallet) => [wallet.name, wallet.address, wallet.chainId]));
      const result = await cache.get(key, TTL.balances, () => walletBalances(wallets, rpc(), { solanaRpcUrl: config.rpcUrls[SOLANA], pricesUrl: process.env.DEFI_TOOL_PRICES_URL }), { refresh: query.refresh });
      balances = result.value;
      cachedAt = result.cachedAt;
    }
    return {
      data: wallets.map((wallet, index) => {
        const balance = balances?.get(wallet.name);
        return {
          ...wallet, number: index + 1, chain: CHAINS[wallet.chainId].slug, chainName: CHAINS[wallet.chainId].name, type: isEvmChain(wallet.chainId) ? 'evm' : 'solana',
          default: defaults?.wallet.name === wallet.name, chosenDefault: defaults?.wallet.name === wallet.name && defaults.chosen,
          ...(balance instanceof Error ? { balanceError: balance.message.split('\n')[0] } : balance ? { balance } : {}),
        };
      }),
      default: defaults ? { name: defaults.wallet.name, chosen: defaults.chosen } : undefined,
      initWallets: config.wallets.length, cachedAt,
    };
  });

  const walletBody = z.object({ address: z.string().trim().min(1, 'address is required').max(100), chain: z.string().trim().min(1, 'chain is required').max(40), name: z.string().trim().max(60).optional() });
  router.post('/api/wallets', async (ctx) => {
    writable();
    const body = parse(walletBody, await ctx.body());
    const { wallet, isDefault } = addWallet(store, body);
    cache.invalidate('balances');
    hub.broadcast('wallets', { change: 'added', name: wallet.name });
    return { data: { ...wallet, default: isDefault } };
  });
  router.patch('/api/wallets/:name', async (ctx) => {
    writable();
    const body = parse(z.object({ name: z.string().trim().max(60).optional(), chain: z.string().trim().max(40).optional() }), await ctx.body());
    const { before, after } = editWallet(store, ctx.params.name!, { name: body.name || undefined, chain: body.chain || undefined });
    cache.invalidate('balances');
    hub.broadcast('wallets', { change: 'updated', name: after.name, previous: before.name });
    return { data: after };
  });
  router.delete('/api/wallets/:name', (ctx) => {
    writable();
    const removed = deleteWallet(store, ctx.params.name!);
    cache.invalidate('balances');
    hub.broadcast('wallets', { change: 'deleted', name: removed.name });
    return { data: removed };
  });
  router.put('/api/wallets/default', async (ctx) => {
    writable();
    const body = parse(z.object({ wallet: z.string().trim().min(1, 'wallet is required').max(100), chain: z.string().trim().max(40).optional() }), await ctx.body());
    const saved = setDefaultWallet(store, body.wallet, body.chain || undefined);
    hub.broadcast('wallets', { change: 'default', name: saved.name });
    return { data: saved };
  });

  router.get('/api/history', async (ctx) => {
    const query = parse(z.object({
      wallet: q.text, chain: q.list, days: z.string().trim().default('30'), type: q.list, top: z.string().trim().default('100'), all: q.bool, refresh: q.bool,
    }), ctx.query);
    const request = { target: query.wallet, chain: query.chain, days: query.days, type: query.type, top: query.top, all: query.all };
    const result = await cache.get(cacheKey('history', request), TTL.history, async () => {
      const local = notes();
      const value = await loadHistory(request, { ...deps(local) });
      if (!value.alchemy) local.report('ALCHEMY_API_KEY is not set, so only liquidity activity is shown. A free key adds swaps and transfers.');
      return { value, notes: local.notes };
    }, { refresh: query.refresh });
    const { value } = result.value;
    return {
      data: {
        days: value.days, alchemy: value.alchemy,
        wallets: value.histories.map(({ wallets, address, chains, result: history }) => ({
          wallets, address, chains: chains.map((chain) => CHAINS[chain].slug), allNetworks: chains.length === EVM_CHAINS.length,
          total: history.total, spamHidden: history.spamHidden, summary: history.summary, sources: history.sources, activities: history.activities,
        })),
      },
      notes: result.value.notes, cachedAt: result.cachedAt, cached: result.cached,
    };
  });

  // ---------- positions
  router.get('/api/positions', async (ctx) => {
    const query = parse(walletQuery, ctx.query);
    const selection = { wallet: query.wallet, walletAddr: query.walletAddr, chain: query.chain, source: query.source };
    const result = await cache.get(cacheKey('positions', selection), TTL.positions, async () => {
      const local = notes();
      const view = await listPortfolio(selection, deps(local));
      return { view, notes: local.notes };
    }, { refresh: query.refresh });
    const { view } = result.value;
    return {
      data: { scope: view.scope, source: view.sourceLabel, observedAt: view.observedAt, summary: summarize(view), active: view.active, past: view.past },
      notes: result.value.notes, cachedAt: result.cachedAt, cached: result.cached,
    };
  });

  const detail = async (query: z.infer<typeof detailQuery>) => {
    const request = { reference: query.ref, past: query.past, timeframe: query.timeframe, wallet: query.wallet, walletAddr: query.walletAddr, chain: query.chain, source: query.source, dataDir: state.options.dataDir, offline: state.options.offline };
    return cache.get(cacheKey('detail', request), TTL.detail, async () => {
      const local = notes();
      const value = await positionDetailData(request, deps(local));
      return { value, notes: local.notes };
    }, { refresh: query.refresh });
  };
  router.get('/api/positions/detail', async (ctx) => {
    const result = await detail(parse(detailQuery, ctx.query));
    const { analysis, candles, timeframe, step, dataNote, how } = result.value.value;
    return {
      data: { analysis, how, timeframe, step, dataNote, candles: candles.map((candle) => [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.filled ? 1 : 0]) },
      notes: result.value.notes, cachedAt: result.cachedAt, cached: result.cached,
    };
  });

  // positions create: builds unsigned transactions; nothing is signed, sent or saved, so it also works with --read-only.
  router.add('POST', '/api/positions/plan', async (ctx) => {
    const body = parse(z.object({
      pair: q.text, pool: q.text, chain: z.string().trim().min(1, 'chain is required'), wallet: q.text, amount: z.string().trim().min(1, 'amount is required').max(60),
      lowerLimit: q.text, upperLimit: q.text, fullRange: z.boolean().optional(), fee: q.text, slippage: z.string().trim().default('0.5'), deadline: z.string().trim().default('20m'),
      payWith: z.enum(['auto', 'weth', 'eth']).default('auto'), approve: z.enum(['exact', 'unlimited']).default('exact'),
    }), await ctx.body());
    const n = notes();
    const plan = await buildPlan(body, deps(n));
    return { data: { ...plan, steps: plan.transactions.map((transaction) => ({ ...transaction, mm: mmCommand(plan.chainId, transaction) })) }, notes: n.notes };
  });

  // ---------- pools
  router.get('/api/pools', async (ctx) => {
    const query = parse(z.object({
      mode: z.enum(['scan', 'get', 'rank']).default('scan'), pair: q.text, chain: q.list, protocol: q.list, dex: q.list, sort: q.list,
      top: q.text, minTvl: q.text, token: q.text, source: z.enum(['public', 'geckoterminal', 'custom']).optional(), refresh: q.bool,
    }), ctx.query);
    if (query.mode === 'get' && !query.pair) throw new HttpError(400, 'pair is required for mode=get, e.g. WSOL/USDC.', 'invalid_input');
    const filterTexts = ctx.queryAll('filter').map((text) => text.trim()).filter(Boolean);
    const filters: PoolFilter[] = filterTexts.flatMap((text) => option(text, parseFilters, []));
    const request = {
      mode: query.mode as PoolMode, pair: query.pair, chain: query.chain, protocol: option(query.protocol, parsePoolVersions, [...POOL_VERSIONS]), protocolExplicit: query.protocol !== undefined,
      dex: option(query.dex, parseDexes, [...DEXES]), sort: option(query.sort, parsePoolSorts, ['tvl' as const]), top: query.top, minTvl: query.minTvl, token: query.token, filters, source: query.source, quiet: true,
    };
    const result = await cache.get(cacheKey('pools', { ...request, filters: filterTexts }), TTL.pools, async () => {
      const local = notes();
      const value = await searchPools(request, { config, store, report: local.report });
      return { value, notes: local.notes };
    }, { refresh: query.refresh });
    const { value } = result.value;
    return {
      data: { mode: value.mode, source: value.source, sourceName: value.sourceName, chains: value.chains.map((chain) => CHAINS[chain].slug), pair: value.pair, filters: value.filters.map((filter) => filter.text), sorts: value.sorts, items: value.items, observedAt: value.observedAt },
      notes: result.value.notes, cachedAt: result.cachedAt, cached: result.cached,
    };
  });

  // ---------- charts and tickers
  const chart = async (query: z.infer<typeof chartQuery>) => {
    const request = { ...choice(query, { dex: 'uniswap', protocol: 'v3' }), quote: query.quote, timeframe: query.timeframe, from: query.from, to: query.to, dataDir: state.options.dataDir, offline: state.options.offline || query.offline, refresh: query.refresh };
    return cache.get(cacheKey('chart', request), TTL.chart, async () => {
      const local = notes();
      const value = await loadPoolChart(request, { config, report: local.report });
      return { value, notes: local.notes };
    }, { refresh: query.refresh });
  };
  router.get('/api/pools/chart', async (ctx) => {
    const result = await chart(parse(chartQuery, ctx.query));
    const value = result.value.value;
    return { data: { ...poolChartJson(value), tickerKey: tickerKey({ chainId: value.meta.chainId, address: value.meta.address, quote: ctx.query.quote ?? 'auto' }) }, notes: result.value.notes, cachedAt: result.cachedAt, cached: result.cached };
  });

  router.get('/api/ticker', async (ctx) => {
    if (!state.gecko) throw new HttpError(409, 'Live prices are off: the dashboard runs with --offline.', 'offline');
    const query = parse(z.object({ ...poolChoice, quote: z.string().trim().max(80).default('auto') }), ctx.query);
    const pick = choice(query, { dex: 'uniswap', protocol: 'v3' });
    if (!pick.pair && !pick.pool) throw new HttpError(400, 'Name a pair (pair=WETH/USDC) or a pool address (pool=0x…).', 'invalid_input');
    const n = notes();
    const pool = await cache.get(cacheKey('pool', pick), 10 * 60_000, () => findPool(state.gecko!, pick, config, { onError: (chain, error) => n.report(`${pick.pair} on ${CHAINS[chain].name}: ${error.message}`) }));
    const key = tickerKey({ chainId: pool.value.chainId, address: pool.value.address, quote: query.quote });
    const ticker = await cache.get(`ticker:${key}`, TTL.ticker, async () => tickerJson(await new TickerFeed(state.gecko!, pool.value, query.quote).read()));
    return { data: { key, ticker: ticker.value }, notes: n.notes };
  });

  // ---------- market data (in memory, nothing written)
  router.get('/api/market', async (ctx) => {
    const query = parse(z.object({
      pairs: z.string().trim().min(1, 'pairs is required, e.g. ETH,BTC/ETH').max(300),
      timeframe: z.enum(Object.keys(MARKET_TIMEFRAMES) as [MarketTimeframe, ...MarketTimeframe[]]).default('1h'),
      sample: z.enum(['auto', ...Object.keys(SAMPLE_PERIODS)] as [string, ...string[]]).default('auto'),
      from: z.string().trim().default('30d'), to: z.string().trim().default('now'), refresh: q.bool,
    }), ctx.query);
    if (query.pairs.split(',').filter((item) => item.trim()).length > 6) throw new HttpError(400, 'Chart at most 6 coins or pairs at a time.', 'invalid_input');
    const request = { pairs: query.pairs, timeframe: query.timeframe, sample: query.sample as SamplePeriod | 'auto', from: query.from, to: query.to, fill: 'forward' as const };
    const result = await cache.get(cacheKey('market', request), TTL.market, () => marketData(request), { refresh: query.refresh });
    return {
      data: {
        from: isoTime(result.value.range.start), to: isoTime(result.value.range.end), timeframe: query.timeframe,
        series: result.value.results.map((item) => ({
          label: item.label, error: item.error, dataset: item.dataset,
          candles: item.candles?.map((candle) => [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.samples, candle.filled ? 1 : 0]),
        })),
      },
      cachedAt: result.cachedAt, cached: result.cached,
    };
  });

  // ---------- downloads (background jobs) and files
  const dexDownloadBody = z.object({
    pairs: q.text, pool: q.text, chain: q.list, dex: q.list, protocol: q.list, fee: q.text,
    timeframe: z.enum(Object.keys(GECKO_TIMEFRAMES) as [Timeframe, ...Timeframe[]]).default('1h'), from: z.string().trim().default('30d'), to: z.string().trim().default('now'),
    format: z.enum(CANDLE_FORMATS).default('csv'), quote: z.string().trim().max(80).default('auto'), fill: z.enum(FILL_MODES).default('forward'),
    includePartial: z.boolean().optional(), force: z.boolean().optional(), dryRun: z.boolean().optional(),
  });
  router.post('/api/downloads/dex', async (ctx) => {
    const body = parse(dexDownloadBody, await ctx.body());
    if (!body.dryRun) writable();
    if (state.options.offline) throw new HttpError(409, 'Downloads need GeckoTerminal; the dashboard runs with --offline.', 'offline');
    const request = { ...body, ...choice(body, { dex: 'uniswap', protocol: 'v3' }), pairs: body.pairs, outDir: state.options.dataDir };
    // Check the request now, so a mistake is a 400 instead of a failed job.
    if (Boolean(request.pairs) === Boolean(request.pool)) throw new HttpError(400, 'Give pairs (e.g. WETH/USDC) or a pool address, not both.', 'invalid_input');
    const job = jobs.start('dex-download', `${body.dryRun ? 'Dry run' : 'DEX candles'}: ${request.pairs ?? request.pool} · ${body.timeframe}`, async (io) => {
      const { results, range } = await downloadDex(request, { config, report: io.note, progress: io.progress });
      return { from: isoTime(range.start), to: isoTime(range.end), results: results.map((item) => ({ ...item, files: item.files?.map((file) => basename(file)) })) };
    });
    return { data: jobSummary(job) };
  });
  router.post('/api/downloads/market', async (ctx) => {
    const body = parse(z.object({
      pairs: z.string().trim().min(1, 'pairs is required, e.g. ETH,BTC/ETH').max(300),
      timeframe: z.enum(Object.keys(MARKET_TIMEFRAMES) as [MarketTimeframe, ...MarketTimeframe[]]).default('1h'),
      sample: z.enum(['auto', ...Object.keys(SAMPLE_PERIODS)] as [string, ...string[]]).default('auto'),
      from: z.string().trim().default('30d'), to: z.string().trim().default('now'), format: z.enum(CANDLE_FORMATS).default('csv'), fill: z.enum(FILL_MODES).default('forward'),
      includePartial: z.boolean().optional(), force: z.boolean().optional(), dryRun: z.boolean().optional(),
    }), await ctx.body());
    if (!body.dryRun) writable();
    if (state.options.offline) throw new HttpError(409, 'Downloads need DefiLlama; the dashboard runs with --offline.', 'offline');
    const job = jobs.start('market-download', `${body.dryRun ? 'Dry run' : 'Market candles'}: ${body.pairs} · ${body.timeframe}`, async (io) => {
      const { results, range } = await marketData({ ...body, sample: body.sample as SamplePeriod | 'auto', write: { format: body.format, outDir: state.options.marketDir, force: body.force } }, { progress: io.progress });
      return { from: isoTime(range.start), to: isoTime(range.end), results: results.map(({ candles: _, ...item }) => ({ ...item, files: item.files?.map((file) => basename(file)) })) };
    });
    return { data: jobSummary(job) };
  });

  router.get('/api/files', async () => {
    const dex = await Promise.all((await listCachedFiles(state.options.dataDir)).map(async (file) => ({
      kind: 'dex', name: basename(file.path), format: file.format, ...await fileInfo(file.path),
      pair: file.meta.pair, chain: CHAINS[file.meta.pool.chainId]?.slug, chainId: file.meta.pool.chainId, pool: file.meta.pool.address, poolName: file.meta.pool.name,
      dex: file.meta.pool.dex, version: file.meta.pool.version, feeTier: file.meta.pool.feeTier, timeframe: file.meta.timeframe, from: file.meta.from, to: file.meta.to,
      candles: file.meta.candles, priceUnit: file.meta.priceUnit, quote: file.meta.quoteToken?.address ?? 'usd', downloadedAt: file.meta.downloadedAt,
    })));
    const market = await Promise.all((await marketFiles(state.options.marketDir)).map(async ({ name, meta }) => ({
      kind: 'market', name, format: name.split('.').pop(), ...await fileInfo(join(state.options.marketDir, name)),
      pair: meta.pair, timeframe: meta.timeframe, from: meta.from, to: meta.to, candles: meta.candles, priceUnit: meta.priceUnit, sample: meta.sample, downloadedAt: meta.downloadedAt,
    })));
    return { data: { dataDir: state.options.dataDir, marketDir: state.options.marketDir, files: [...dex, ...market].sort((a, b) => String(b.downloadedAt ?? '').localeCompare(String(a.downloadedAt ?? ''))) } };
  });

  // A saved file, by kind and file name only; the name must be a file listed in that folder (no paths).
  router.get('/api/files/raw', async (ctx) => {
    const query = parse(z.object({ kind: z.enum(['dex', 'market']), name: z.string().min(1).max(300) }), ctx.query);
    const directory = resolve(query.kind === 'dex' ? state.options.dataDir : state.options.marketDir);
    if (query.name !== basename(query.name) || query.name.startsWith('.') || /[\\/\0]/.test(query.name)) throw new HttpError(400, 'name must be a file name from the file list, without a folder.', 'bad_name');
    const path = resolve(directory, query.name);
    if (!path.startsWith(directory + sep)) throw new HttpError(400, 'name must be a file name from the file list.', 'bad_name');
    const listed = query.kind === 'dex'
      ? (await listCachedFiles(state.options.dataDir)).some((file) => basename(file.path) === query.name || `${basename(file.path)}${MARKET_META}` === query.name)
      : (await marketFiles(state.options.marketDir)).some((file) => file.name === query.name || `${file.name}${MARKET_META}` === query.name);
    if (!listed) throw new HttpError(404, `No ${query.kind} file named ${query.name}.`, 'not_found');
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new HttpError(404, `No ${query.kind} file named ${query.name}.`, 'not_found');
    const types: Record<string, string> = { csv: 'text/csv', json: 'application/json', jsonl: 'application/x-ndjson', parquet: 'application/vnd.apache.parquet' };
    ctx.res.writeHead(200, {
      'content-type': `${types[query.name.split('.').pop()!] ?? 'application/octet-stream'}`, 'content-length': info.size, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${query.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
    await new Promise<void>((done, fail) => createReadStream(path).on('error', fail).on('end', done).pipe(ctx.res));
    return undefined;
  });

  // ---------- alerts
  router.get('/api/alerts', (ctx) => {
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), wallet: q.list }), ctx.query);
    const wallets = query.wallet?.split(',').map((item) => store.wallet(item.trim())?.address ?? item.trim()).filter(Boolean);
    return { data: store.alerts({ limit: query.limit, wallets }) };
  });
  router.post('/api/alerts/check', async (ctx) => {
    writable();
    const body = parse(z.object({ wallet: q.list, chain: q.list, protocol: z.enum(['v3', 'v4']).default('v3'), position: q.list }), await ctx.body());
    if (body.chain) option(body.chain, parseChains, undefined);
    const job = jobs.start('alerts-check', `Alerts check: ${body.wallet ?? 'default wallet'}${body.chain ? ` on ${body.chain}` : ''}`, async (io) => {
      io.progress('Reading positions over RPC…');
      const result = await checkPositions(body, 'alerts', { config, store, report: io.note, quiet: true });
      return { fresh: result.fresh, unknown: result.unknown, analyses: result.analyses };
    });
    return { data: jobSummary(job) };
  });
  router.post('/api/alerts/:fingerprint/ack', (ctx) => {
    writable();
    if (!store.acknowledgeAlert(ctx.params.fingerprint!)) throw new HttpError(404, 'No alert with that fingerprint.', 'not_found');
    return { data: { acknowledged: true } };
  });

  // ---------- jobs
  router.get('/api/jobs', () => ({ data: jobs.list().map(jobSummary) }));
  router.get('/api/jobs/:id', (ctx) => {
    const job = jobs.get(ctx.params.id!);
    if (!job) throw new HttpError(404, 'No job with that ID (finished jobs are kept for a while only).', 'not_found');
    return { data: job };
  });

  // ---------- events
  router.get('/api/events', (ctx) => {
    hub.connect(ctx.res, ctx.queryAll('ticker').concat((ctx.query.tickers ?? '').split(',')).map((text) => text.trim()).filter(Boolean));
    return undefined;
  });

  // ---------- report pages, shown in the dashboard's frames: the same HTML as dex-data show and positions detail --output html
  const page = (ctx: Context, html: string) => {
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': pageCsp(ctx.nonce) });
    ctx.res.end(withNonce(html, ctx.nonce));
    return undefined;
  };
  router.get('/report/chart', async (ctx) => {
    const result = await chart(parse(chartQuery, ctx.query));
    return page(ctx, buildChartHtml(result.value.value.view));
  });
  router.get('/report/position', async (ctx) => {
    const result = await detail(parse(detailQuery, ctx.query));
    const { analysis, candles, timeframe, step, dataNote } = result.value.value;
    return page(ctx, buildPositionHtml(analysis, { candles, timeframe: timeframe ?? '1h', step, dataNote, plot: true }));
  });
}

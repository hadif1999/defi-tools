import { join } from 'node:path';
import { parseChains } from '../config.js';
import { GECKO_TIMEFRAMES, GeckoTerminalClient, OHLCV_PAGE, type GeckoPool, type Timeframe } from '../providers/geckoterminal.js';
import { candleRange, datasetFileName, datasetHeader, downloadDataset, priceUnit, resolvePool } from '../dex-data.js';
import { autoSample, buildCandles, coverage, downloadSamples, marketFileName, marketRange, parseMarketPair, resolveCoin, sampleCandidates, sampleRequests, writeMarketData, MARKET_TIMEFRAMES, SAMPLE_PERIODS, type Coin, type MarketCandle, type MarketDataset, type MarketTimeframe, type SamplePeriod } from '../market-data.js';
import { searchCoins } from '../providers/coingecko.js';
import { coinSymbols } from '../providers/prices.js';
import { isoTime, parseTime, type CandleFormat, type FillMode } from '../candle-files.js';
import type { DexDownload, MarketDownload } from '../output.js';
import { CHAINS, type AppConfig, type Dex, type PoolVersion } from '../types.js';
import { parseFeeTier } from './pool-chart.js';
import type { Report } from './wallets.js';

// dex-data download and market-data download as data functions, shared by the CLI and the dashboard's jobs.

export interface DexDownloadRequest {
  /** Pairs, comma-separated (WETH/USDC,cbBTC/USDC), or pool addresses with `pool`. */
  pairs?: string;
  pool?: string;
  chain?: string;
  dex: Dex[];
  protocol: PoolVersion[];
  fee?: string;
  timeframe: Timeframe;
  from: string;
  to: string;
  format: CandleFormat;
  outDir: string;
  quote: string;
  fill: FillMode;
  includePartial?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export interface DownloadDeps { config: AppConfig; report: Report; progress?: (text: string) => void }

export async function downloadDex(request: DexDownloadRequest, { config, report, progress = () => {} }: DownloadDeps): Promise<{ results: DexDownload[]; range: { start: number; end: number } }> {
  if (request.pairs && request.pool) throw new Error('Give either pairs or --pool, not both.');
  if (!request.pairs && !request.pool) throw new Error('Name one or more pairs, e.g. defi-tool dex-data download WETH/USDC --chain base, or use --pool.');
  const chains = parseChains(request.chain) ?? config.chains;
  const feeTier = parseFeeTier(request.fee);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const range = candleRange(request.timeframe, parseTime(request.from, '--from', nowMs), parseTime(request.to, '--to', nowMs), now, Boolean(request.includePartial));
  const client = new GeckoTerminalClient({ endpoint: process.env.DEFI_TOOL_GECKOTERMINAL_URL });

  // Find each target's pool first, so a typo fails before any long download starts.
  const targets: Array<{ label: string; pool?: GeckoPool; alternatives: GeckoPool[]; error?: string }> = [];
  if (request.pool) {
    if (chains.length !== 1) throw new Error('--pool needs exactly one network, e.g. --chain base.');
    for (const address of request.pool.split(',').map((item) => item.trim()).filter(Boolean)) {
      try { targets.push({ label: address, pool: await client.pool(chains[0]!, address), alternatives: [] }); }
      catch (error) { targets.push({ label: address, alternatives: [], error: (error as Error).message }); }
    }
  } else {
    for (const text of request.pairs!.split(',').map((item) => item.trim()).filter(Boolean)) {
      try {
        targets.push({ label: text, ...await resolvePool(client, text, chains, { dexes: request.dex, versions: request.protocol, feeTier }, {
          onSearch: (chain) => progress(`Finding ${text} on ${CHAINS[chain].name}…`),
          onError: (chain, error) => report(`\n${text} on ${CHAINS[chain].name}: ${error.message}`),
        }) });
      } catch (error) { targets.push({ label: text, alternatives: [], error: (error as Error).message }); }
    }
  }
  progress('');

  const results: DexDownload[] = [];
  for (const target of targets) {
    if (!target.pool) { results.push({ label: target.label, alternatives: [], error: target.error }); continue; }
    const pool = target.pool;
    try {
      const unit = priceUnit(pool, request.quote);
      const periods = (range.end - range.start) / GECKO_TIMEFRAMES[request.timeframe].seconds;
      const header = datasetHeader(pool, unit, target.label, request.timeframe, range.start, range.end, request.fill);
      if (request.dryRun) {
        results.push({ label: target.label, pool, alternatives: target.alternatives, dataset: header, plannedRequests: Math.ceil(periods / OHLCV_PAGE), files: [join(request.outDir, datasetFileName(header, range.start, range.end, request.format))] });
        continue;
      }
      const { dataset, files } = await downloadDataset(client, pool, unit, header, range.start, range.end, { directory: request.outDir, format: request.format, force: Boolean(request.force) },
        (pages, oldest) => progress(`${target.label}: ${pages} request${pages === 1 ? '' : 's'}, back to ${isoTime(Math.max(oldest, range.start)).slice(0, 16).replace('T', ' ')}…`));
      results.push({ label: target.label, pool, alternatives: target.alternatives, dataset, files });
    } catch (error) {
      results.push({ label: target.label, pool, alternatives: target.alternatives, error: (error as Error).message });
    }
    progress('');
  }
  return { results, range };
}

export interface MarketRequest {
  /** Coins or pairs, comma-separated: ETH, BTC/ETH, coingecko:<id>, chain:address. */
  pairs: string;
  timeframe: MarketTimeframe;
  sample: SamplePeriod | 'auto';
  from: string;
  to: string;
  fill: FillMode;
  includePartial?: boolean;
  /** Save files (market-data download); without it the candles are only returned (the dashboard's chart). */
  write?: { format: CandleFormat; outDir: string; force?: boolean };
  dryRun?: boolean;
}

export interface MarketResult extends MarketDownload { candles?: MarketCandle[] }

export async function marketData(request: MarketRequest, { progress = () => {} }: { progress?: (text: string) => void } = {}): Promise<{ results: MarketResult[]; range: { start: number; end: number } }> {
  const pairs = request.pairs.split(',').map((item) => item.trim()).filter(Boolean).map((text) => ({ text, tokens: parseMarketPair(text) }));
  if (!pairs.length) throw new Error('Name one or more coins or pairs, e.g. defi-tool market-data download ETH,BTC/ETH.');
  const sample = request.sample === 'auto' ? autoSample(request.timeframe) : request.sample;
  if (SAMPLE_PERIODS[sample] > MARKET_TIMEFRAMES[request.timeframe]) throw new Error(`--sample ${sample} is longer than a ${request.timeframe} candle. Choose a shorter --sample or a longer --timeframe.`);
  const nowMs = Date.now();
  const range = marketRange(request.timeframe, parseTime(request.from, '--from', nowMs), parseTime(request.to, '--to', nowMs), Math.floor(nowMs / 1000), Boolean(request.includePartial));
  const prices = { endpoint: process.env.DEFI_TOOL_PRICES_URL };
  const format = request.write?.format ?? 'csv';
  const outDir = request.write?.outDir ?? 'market-data';

  // Look up every coin first, once each, so a typo fails before any long download starts.
  const coins = new Map<string, Promise<Coin>>();
  const coin = (query: string) => {
    const key = query.toLowerCase();
    if (!coins.has(key)) coins.set(key, resolveCoin(query, (text) => { progress(`Looking up ${text} on CoinGecko…`); return searchCoins(text, { endpoint: process.env.DEFI_TOOL_COINGECKO_URL }); },
      (keys) => coinSymbols(keys, prices)));
    return coins.get(key)!;
  };
  const results: MarketResult[] = [];
  for (const pair of pairs) {
    try {
      const base = await coin(pair.tokens[0]);
      const quote = await coin(pair.tokens[1]);
      if (base.key === quote.key) throw new Error(`${pair.text} prices a coin in itself.`);
      const dataset: Omit<MarketDataset, 'candles' | 'validation' | 'requests' | 'downloadedAt'> = {
        source: 'defillama', pair: pair.text, base, quote, priceUnit: `${quote.symbol} per ${base.symbol}`,
        method: quote.key === 'usd' ? `${base.symbol}'s blended USD price` : `cross rate: ${base.symbol} USD price ÷ ${quote.symbol} USD price`,
        timeframe: request.timeframe, sample, from: isoTime(range.start), to: isoTime(range.end), fill: request.fill,
      };
      const fileName = marketFileName(base, quote, request.timeframe, range.start, range.end, format);
      if (request.dryRun) {
        results.push({ label: pair.text, dataset, plannedRequests: sampleRequests([base, quote], range.start, range.end, sample), files: [join(outDir, fileName)] });
        continue;
      }
      // DefiLlama keeps smaller coins at 15-minute or coarser spacing; with --sample auto, a sparse result is retried at
      // the next coarser spacing, and the fullest result is kept.
      let best: { sample: SamplePeriod; series: Awaited<ReturnType<typeof downloadSamples>>['series']; score: number } | undefined;
      let requests = 0;
      for (const period of request.sample === 'auto' ? sampleCandidates(request.timeframe) : [sample]) {
        const downloaded = await downloadSamples([base, quote], range.start, range.end, period, prices,
          (count, reached) => progress(`${pair.text}: ${period} samples, ${count} request${count === 1 ? '' : 's'}, up to ${isoTime(reached).slice(0, 16).replace('T', ' ')}…`));
        requests += downloaded.requests;
        const score = coverage(buildCandles(base, quote, downloaded.series, request.timeframe, period, range.start, range.end, 'forward').candles);
        if (!best || score > best.score) best = { sample: period, series: downloaded.series, score };
        if (score >= 0.9) break;
      }
      const used = best!.sample;
      const { candles, validation } = buildCandles(base, quote, best!.series, request.timeframe, used, range.start, range.end, request.fill);
      const full: MarketDataset = { ...dataset, sample: used, downloadedAt: new Date().toISOString(), requests, candles: candles.length, validation };
      results.push({
        label: pair.text, dataset: full,
        ...(request.write ? { files: await writeMarketData(outDir, fileName, candles, full, format, Boolean(request.write.force)) } : { candles }),
      });
    } catch (error) {
      results.push({ label: pair.text, error: (error as Error).message });
    }
    progress('');
  }
  progress('');
  return { results, range };
}

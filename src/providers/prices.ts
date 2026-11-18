import type { EvmChainId } from '../types.js';
import { getJson, positive, retryRateLimit } from './http.js';

// DefiLlama's public coins API (no key): current USD prices by chain:address. https://defillama.com/docs/api
export const PRICES_URL = 'https://coins.llama.fi';
const chainNames: Record<EvmChainId, string> = { 1: 'ethereum', 10: 'optimism', 56: 'bsc', 137: 'polygon', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' };
const BATCH = 50;

/** Current USD prices keyed by "chainId:lowercase address"; tokens without a price are absent. */
export async function usdPrices(tokens: Array<{ chainId: EvmChainId; address: string }>, options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number>> {
  const keys = [...new Set(tokens.map((token) => `${chainNames[token.chainId]}:${token.address.toLowerCase()}`))];
  const prices = new Map<string, number>();
  for (let start = 0; start < keys.length; start += BATCH) {
    const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/prices/current/${keys.slice(start, start + BATCH).join(',')}`;
    const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { price?: unknown }> } | null;
    for (const [key, coin] of Object.entries(body?.coins ?? {})) {
      const [chain, address] = key.split(':');
      const chainId = Object.entries(chainNames).find(([, name]) => name === chain)?.[0];
      const price = positive(coin?.price);
      if (chainId && address && price !== undefined) prices.set(`${chainId}:${address.toLowerCase()}`, price);
    }
  }
  return prices;
}

/** Daily USD prices over the last `days` days, oldest first, keyed like usdPrices; tokens without history are absent. */
export async function dailyPrices(tokens: Array<{ chainId: EvmChainId; address: string }>, days: number, options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number[]>> {
  const keys = [...new Set(tokens.map((token) => `${chainNames[token.chainId]}:${token.address.toLowerCase()}`))];
  const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/chart/${keys.join(',')}?span=${days + 1}&period=1d`;
  const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { prices?: Array<{ timestamp?: unknown; price?: unknown }> }> } | null;
  const history = new Map<string, number[]>();
  for (const [key, coin] of Object.entries(body?.coins ?? {})) {
    const [chain, address] = key.split(':');
    const chainId = Object.entries(chainNames).find(([, name]) => name === chain)?.[0];
    const prices = (coin?.prices ?? []).map((point) => positive(point.price)).filter((price): price is number => price !== undefined);
    if (chainId && address && prices.length) history.set(`${chainId}:${address.toLowerCase()}`, prices);
  }
  return history;
}

/** DefiLlama's key for a token: "base:0x…". */
export const priceKey = (chainId: EvmChainId, address: string): string => `${chainNames[chainId]}:${address.toLowerCase()}`;

/** Current USD prices for DefiLlama coin keys such as "base:0x…" or "coingecko:ethereum", keyed lowercase as given. */
export async function coinPrices(keys: string[], options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number>> {
  const unique = [...new Set(keys.map((key) => key.toLowerCase()))];
  const prices = new Map<string, number>();
  for (let start = 0; start < unique.length; start += BATCH) {
    const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/prices/current/${unique.slice(start, start + BATCH).join(',')}`;
    const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { price?: unknown }> } | null;
    for (const [key, coin] of Object.entries(body?.coins ?? {})) {
      const price = positive(coin?.price);
      if (price !== undefined) prices.set(key.toLowerCase(), price);
    }
  }
  return prices;
}

const NATIVE_PRICE_KEYS: Record<EvmChainId, string> = { 1: 'coingecko:ethereum', 10: 'coingecko:ethereum', 56: 'coingecko:binancecoin', 137: 'coingecko:polygon-ecosystem-token', 4663: 'coingecko:ethereum', 8453: 'coingecko:ethereum', 42161: 'coingecko:ethereum' };
/** DefiLlama's key for a network's native coin, or for a token when an address is given. */
export const assetPriceKey = (chainId: EvmChainId, address?: string): string => address ? priceKey(chainId, address) : NATIVE_PRICE_KEYS[chainId];

/**
 * USD prices at given times, keyed "key@timestamp" (key lowercase, timestamp in seconds), from DefiLlama's batch
 * historical endpoint: the closest price within 6 hours of each time. Requests are split to keep URLs short.
 */
export async function historicalPrices(requests: Array<{ key: string; timestamp: number }>, options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number>> {
  const byKey = new Map<string, Set<number>>();
  for (const { key, timestamp } of requests) byKey.set(key.toLowerCase(), (byKey.get(key.toLowerCase()) ?? new Set()).add(timestamp));
  const prices = new Map<string, number>();
  const entries = [...byKey];
  for (let start = 0; start < entries.length;) {
    // About 60 key/time pairs per request.
    const chunk: Array<[string, number[]]> = [];
    let size = 0;
    while (start < entries.length && (size === 0 || size + entries[start]![1].size <= 60)) { const [key, times] = entries[start++]!; chunk.push([key, [...times]]); size += times.size; }
    const coins = encodeURIComponent(JSON.stringify(Object.fromEntries(chunk)));
    const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/batchHistorical?coins=${coins}&searchWidth=6h`;
    const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { prices?: Array<{ timestamp?: unknown; price?: unknown }> }> } | null;
    for (const [key, times] of chunk) {
      const points = (body?.coins?.[key] ?? Object.entries(body?.coins ?? {}).find(([name]) => name.toLowerCase() === key)?.[1])?.prices ?? [];
      const valid = points.flatMap((point) => typeof point.timestamp === 'number' && positive(point.price) !== undefined ? [{ timestamp: point.timestamp, price: positive(point.price)! }] : []);
      // Each requested time takes the closest returned point.
      for (const time of times) {
        const closest = valid.reduce<{ timestamp: number; price: number } | undefined>((best, point) => !best || Math.abs(point.timestamp - time) < Math.abs(best.timestamp - time) ? point : best, undefined);
        if (closest && Math.abs(closest.timestamp - time) <= 6 * 3600) prices.set(`${key}@${time}`, closest.price);
      }
    }
  }
  return prices;
}

/** The most points one chart request may ask for, across all its coins (two coins get 250 each). */
export const CHART_POINTS = 500;

export interface ChartSeries { symbol?: string; confidence?: number; prices: unknown[] }

/**
 * Price samples for DefiLlama coin keys ("coingecko:ethereum", "base:0x…"): `span` points `period` apart from `start`
 * (unix seconds), keyed lowercase. Coins without data in the window are absent. Points are returned unchecked.
 */
export async function priceChart(keys: string[], start: number, span: number, period: string, options: { endpoint?: string; fetcher?: typeof fetch; rateLimitWaitMs?: number } = {}): Promise<Map<string, ChartSeries>> {
  if (span < 1 || span * keys.length > CHART_POINTS) throw new Error(`DefiLlama charts take at most ${CHART_POINTS} points per request across all coins.`);
  const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/chart/${keys.join(',')}?start=${start}&span=${span}&period=${period}`;
  const body = await retryRateLimit(() => getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 30_000), options.rateLimitWaitMs ?? 10_000) as { coins?: Record<string, { symbol?: unknown; confidence?: unknown; prices?: unknown }> } | null;
  const series = new Map<string, ChartSeries>();
  for (const [key, coin] of Object.entries(body?.coins ?? {})) {
    series.set(key.toLowerCase(), {
      symbol: typeof coin?.symbol === 'string' ? coin.symbol : undefined,
      confidence: typeof coin?.confidence === 'number' ? coin.confidence : undefined,
      prices: Array.isArray(coin?.prices) ? coin.prices : [],
    });
  }
  return series;
}

/** DefiLlama's symbol for each coin key it knows (keyed lowercase); unknown keys are absent. */
export async function coinSymbols(keys: string[], options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, string>> {
  const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/prices/current/${keys.join(',')}`;
  const body = await retryRateLimit(() => getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000), 10_000) as { coins?: Record<string, { symbol?: unknown }> } | null;
  return new Map(Object.entries(body?.coins ?? {}).flatMap(([key, coin]) => typeof coin?.symbol === 'string' ? [[key.toLowerCase(), coin.symbol] as [string, string]] : []));
}

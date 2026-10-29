import { z } from 'zod';
import type { ChainId, Dex, PoolVersion } from '../types.js';
import { feeTierFromPercent, getJson, nonnegative, retryRateLimit } from './http.js';
import { PUBLIC_POOLS_URL } from './public-pools.js';

// Public REST API: https://apiguide.geckoterminal.com/ (about 30 requests a minute, no key).
export const GECKO_NETWORKS: Record<ChainId, string> = {
  1: 'eth', 10: 'optimism', 56: 'bsc', 137: 'polygon_pos', 501: 'solana', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum',
};

/** Candle sizes GeckoTerminal serves: its timeframe name and the aggregate it takes. */
export const GECKO_TIMEFRAMES = {
  '1m': { timeframe: 'minute', aggregate: 1, seconds: 60 },
  '5m': { timeframe: 'minute', aggregate: 5, seconds: 300 },
  '15m': { timeframe: 'minute', aggregate: 15, seconds: 900 },
  '1h': { timeframe: 'hour', aggregate: 1, seconds: 3_600 },
  '4h': { timeframe: 'hour', aggregate: 4, seconds: 14_400 },
  '12h': { timeframe: 'hour', aggregate: 12, seconds: 43_200 },
  '1d': { timeframe: 'day', aggregate: 1, seconds: 86_400 },
} as const;
export type Timeframe = keyof typeof GECKO_TIMEFRAMES;

/** The most candles one OHLCV request returns. */
export const OHLCV_PAGE = 1_000;

export interface GeckoToken { address: string; symbol: string }

/** A pool as GeckoTerminal lists it, with the exchange and pool type in this CLI's terms. */
export interface GeckoPool {
  chainId: ChainId;
  /** Pool contract address, or a v4 pool ID (0x + 64 hex characters). */
  address: string;
  name: string;
  /** GeckoTerminal's exchange ID, e.g. uniswap-v3-base. */
  dexId: string;
  dex?: Dex;
  version?: PoolVersion;
  /** Fee in Uniswap units (3000 = 0.3%) when the pool name gives one. */
  feeTier?: number;
  base: GeckoToken;
  quote: GeckoToken;
  tvlUsd?: number;
  createdAt?: string;
}

/**
 * Map a GeckoTerminal exchange ID to the exchange and pool type used by --dex and --protocol. IDs vary by network
 * (uniswap_v3, uniswap-v3-base, uniswap-bsc for BNB Chain's v3); unknown exchanges and forks return undefined.
 */
export function classifyDex(dexId: string): { dex: Dex; version: PoolVersion } | undefined {
  const id = dexId.toLowerCase();
  const version = /(?:^|[-_])v([234])(?:$|[-_])/.exec(id)?.[1];
  if (id.startsWith('uniswap')) return { dex: 'uniswap', version: version ? `v${version}` as PoolVersion : id === 'uniswap-bsc' ? 'v3' : 'v2' };
  if (id.startsWith('pancakeswap')) return version === '2' || version === '3' ? { dex: 'pancakeswap', version: `v${version}` } : undefined;
  if (id.startsWith('aerodrome') || id.startsWith('aero-')) return { dex: 'aerodrome', version: id.includes('slipstream') ? 'clmm' : 'amm' };
  if (id.startsWith('curve')) return { dex: 'curve', version: 'amm' };
  if (id.startsWith('raydium')) return { dex: 'raydium', version: id.includes('clmm') ? 'clmm' : 'amm' };
  return undefined;
}

const reference = z.object({ data: z.object({ id: z.string() }) });
const poolResource = z.object({
  attributes: z.object({ address: z.string(), name: z.string(), reserve_in_usd: z.unknown().optional(), pool_created_at: z.string().nullish() }),
  relationships: z.object({ base_token: reference, quote_token: reference, dex: reference }),
});
const included = z.array(z.object({ id: z.string(), type: z.string(), attributes: z.record(z.unknown()) })).default([]);
const poolsSchema = z.object({ data: z.array(poolResource), included });
const poolSchema = z.object({ data: poolResource, included });
const ohlcvSchema = z.object({
  data: z.object({ attributes: z.object({ ohlcv_list: z.array(z.array(z.unknown())) }) }),
});

export interface GeckoTerminalOptions {
  endpoint?: string;
  fetcher?: typeof fetch;
  /** Spacing between requests; the public API allows about 30 a minute. */
  intervalMs?: number;
  /** How long to wait after a rate-limit response before retrying, doubled on each retry. */
  rateLimitWaitMs?: number;
}

export class GeckoTerminalClient {
  private readonly fetcher: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(private readonly options: GeckoTerminalOptions = {}) { this.fetcher = options.fetcher ?? fetch; }

  /** One request at a time, spaced out; a rate limit (HTTP 429) waits and retries up to three times. */
  private request(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${(this.options.endpoint ?? PUBLIC_POOLS_URL).replace(/\/$/, '')}/${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const interval = this.options.intervalMs ?? 2_100;
    const task = this.pending.then(() => retryRateLimit(async () => {
      const wait = Math.max(0, interval - (Date.now() - this.lastRequest));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequest = Date.now();
      return getJson(this.fetcher, url.href, 'GeckoTerminal', 20_000, interval);
    }, this.options.rateLimitWaitMs ?? 20_000));
    this.pending = task.catch(() => undefined);
    return task;
  }

  private toPools(chainId: ChainId, body: unknown, schema: typeof poolsSchema | typeof poolSchema): GeckoPool[] {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error('Malformed GeckoTerminal pool response.');
    const tokens = new Map(parsed.data.included.filter((item) => item.type === 'token').map((item) => [item.id, item.attributes]));
    const network = GECKO_NETWORKS[chainId];
    const token = (id: string): GeckoToken => {
      const data = tokens.get(id);
      return { address: typeof data?.address === 'string' ? data.address : id.slice(network.length + 1), symbol: typeof data?.symbol === 'string' ? data.symbol : '?' };
    };
    return (Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data]).map((item) => {
      const dexId = item.relationships.dex.data.id;
      // Names look like "WETH / USDC 0.05%"; the trailing percentage is the fee tier.
      const fee = /\s(\d+(?:\.\d+)?%)$/.exec(item.attributes.name)?.[1];
      return {
        chainId, address: item.attributes.address, name: item.attributes.name, dexId, ...classifyDex(dexId),
        feeTier: fee === undefined ? undefined : feeTierFromPercent(fee),
        base: token(item.relationships.base_token.data.id), quote: token(item.relationships.quote_token.data.id),
        tvlUsd: nonnegative(item.attributes.reserve_in_usd), createdAt: item.attributes.pool_created_at ?? undefined,
      };
    });
  }

  /** Pools whose tokens match a text search such as "WETH USDC", most relevant first (20 per page). */
  async searchPools(chainId: ChainId, query: string, page = 1): Promise<GeckoPool[]> {
    const body = await this.request('search/pools', { query, network: GECKO_NETWORKS[chainId], include: 'base_token,quote_token,dex', page });
    return this.toPools(chainId, body, poolsSchema);
  }

  /** Pools that trade a token, given by address, deepest first (20 per page). */
  async tokenPools(chainId: ChainId, token: string, page = 1): Promise<GeckoPool[]> {
    const body = await this.request(`networks/${GECKO_NETWORKS[chainId]}/tokens/${token}/pools`, { include: 'base_token,quote_token,dex', page });
    return this.toPools(chainId, body, poolsSchema);
  }

  /** One pool by address or v4 pool ID. */
  async pool(chainId: ChainId, address: string): Promise<GeckoPool> {
    const body = await this.request(`networks/${GECKO_NETWORKS[chainId]}/pools/${address}`, { include: 'base_token,quote_token,dex' });
    return this.toPools(chainId, body, poolSchema)[0]!;
  }

  /**
   * Up to 1,000 candles ending at `before` (inclusive), newest first, as GeckoTerminal sends them:
   * [unix seconds, open, high, low, close, volume]. Rows are not checked here; see dex-data's validation.
   * `token` is the token priced; with currency "token" prices are in the pool's other token, otherwise in USD.
   */
  async ohlcv(chainId: ChainId, pool: string, timeframe: Timeframe, options: { before?: number; token: string; currency: 'token' | 'usd'; limit?: number }): Promise<unknown[][]> {
    const frame = GECKO_TIMEFRAMES[timeframe];
    const body = await this.request(`networks/${GECKO_NETWORKS[chainId]}/pools/${pool}/ohlcv/${frame.timeframe}`, {
      aggregate: frame.aggregate, before_timestamp: options.before, limit: options.limit ?? OHLCV_PAGE, currency: options.currency, token: options.token,
    });
    const parsed = ohlcvSchema.safeParse(body);
    if (!parsed.success) throw new Error('Malformed GeckoTerminal OHLCV response.');
    return parsed.data.data.attributes.ohlcv_list;
  }
}

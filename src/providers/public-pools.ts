import { z } from 'zod';
import type { EvmChainId, Pool, PoolSort, Protocol } from '../types.js';
import { feeTierFromPercent, finite, getJson, nonnegative, positive } from './http.js';

// Public REST API: https://apiguide.geckoterminal.com/
export const PUBLIC_POOLS_URL = 'https://api.geckoterminal.com/api/v2';
const networks: Record<EvmChainId, { network: string; v3: string; v4: string }> = {
  1: { network: 'eth', v3: 'uniswap_v3', v4: 'uniswap-v4-ethereum' },
  10: { network: 'optimism', v3: 'uniswap_v3_optimism', v4: 'uniswap-v4-optimism' },
  56: { network: 'bsc', v3: 'uniswap-bsc', v4: 'uniswap-v4-bsc' },
  4663: { network: 'robinhood', v3: 'uniswap-v3-robinhood', v4: 'uniswap-v4-robinhood' },
  137: { network: 'polygon_pos', v3: 'uniswap_v3_polygon_pos', v4: 'uniswap-v4-polygon' },
  8453: { network: 'base', v3: 'uniswap-v3-base', v4: 'uniswap-v4-base' },
  42161: { network: 'arbitrum', v3: 'uniswap_v3_arbitrum', v4: 'uniswap-v4-arbitrum' },
};
const reference = z.object({ data: z.object({ id: z.string().min(1) }) });
const resource = z.object({
  id: z.string(),
  attributes: z.record(z.unknown()),
  relationships: z.object({ base_token: reference, quote_token: reference }),
});
const pageSchema = z.object({
  data: z.array(resource),
  included: z.array(z.object({ id: z.string(), attributes: z.record(z.unknown()) })).default([]),
});

export interface PublicPoolsOptions {
  endpoint?: string;
  fetcher?: typeof fetch;
  intervalMs?: number;
}

export class PublicPoolsClient {
  private readonly fetcher: typeof fetch;
  private pending: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(private readonly options: PublicPoolsOptions = {}) { this.fetcher = options.fetcher ?? fetch; }

  private request(url: string): Promise<z.infer<typeof pageSchema>> {
    const task = this.pending.then(async () => {
      const wait = Math.max(0, (this.options.intervalMs ?? 2100) - (Date.now() - this.lastRequest));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequest = Date.now();
      const body = await getJson(this.fetcher, url, 'GeckoTerminal', 15_000, this.options.intervalMs ?? 2100);
      const parsed = pageSchema.safeParse(body);
      if (!parsed.success) throw new Error('Malformed GeckoTerminal public pool response.');
      return parsed.data;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  async listPools(chainId: EvmChainId, protocol: Protocol, limit = 50, sort?: PoolSort): Promise<Pool[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Public pool discovery supports --top 1 through 200 per chain.');
    const network = networks[chainId];
    const pools = new Map<string, Pool>();
    for (let page = 1; page <= 10 && pools.size < limit; page += 1) {
      const url = new URL(`${(this.options.endpoint ?? PUBLIC_POOLS_URL).replace(/\/$/, '')}/networks/${network.network}/dexes/${network[protocol]}/pools`);
      url.searchParams.set('include', 'base_token,quote_token');
      url.searchParams.set('page', String(page));
      // GeckoTerminal can order by 24h volume; other orders are applied by the caller after fetching.
      if (sort === 'volume') url.searchParams.set('sort', 'h24_volume_usd_desc');
      const result = await this.request(url.href);
      const included = new Map(result.included.map((token) => [token.id, token.attributes]));
      const before = pools.size;
      for (const item of result.data) {
        const attributes = item.attributes;
        const id = attributes.address;
        if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(id)) throw new Error('Malformed GeckoTerminal public pool address.');
        const token = (ref: string): Pool['token0'] => {
          const data = included.get(ref);
          const address = typeof data?.address === 'string' ? data.address : ref.slice(network.network.length + 1);
          if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Malformed GeckoTerminal public pool token address.');
          return { address, symbol: typeof data?.symbol === 'string' ? data.symbol : '?', decimals: finite(data?.decimals) };
        };
        let token0 = token(item.relationships.base_token.data.id);
        let token1 = token(item.relationships.quote_token.data.id);
        let price = positive(attributes.base_token_price_quote_token);
        if (token0.address.toLowerCase() > token1.address.toLowerCase()) {
          [token0, token1] = [token1, token0];
          price = price === undefined ? undefined : 1 / price;
        }
        // Names look like "USDC / WETH 0.05%"; the trailing percentage is the fee tier.
        const fee = typeof attributes.name === 'string' ? /\s(\d+(?:\.\d+)?%)$/.exec(attributes.name)?.[1] : undefined;
        const feeTier = fee === undefined ? undefined : feeTierFromPercent(fee);
        const volume24hUsd = nonnegative((attributes.volume_usd as Record<string, unknown> | undefined)?.h24);
        const tvlUsd = nonnegative(attributes.reserve_in_usd);
        const fees24hUsd = feeTier !== undefined && volume24hUsd !== undefined ? volume24hUsd * feeTier / 1_000_000 : undefined;
        pools.set(id.toLowerCase(), {
          id: id.toLowerCase(), address: id.length === 42 ? id.toLowerCase() : undefined, chainId, protocol, name: `${token0.symbol}/${token1.symbol}`, token0, token1, feeTier,
          tvlUsd, volume24hUsd, fees24hUsd,
          // Same method as DefiLlama's APR: a day of fees, annualized against TVL.
          aprPct: fees24hUsd !== undefined && tvlUsd ? fees24hUsd * 365 / tvlUsd * 100 : undefined,
          price, dex: 'Uniswap', source: 'geckoterminal', observedAt: new Date().toISOString(),
          // Price change isn't volatility; hook safety requires other sources.
        });
        if (pools.size === limit) break;
      }
      if (result.data.length < 20 || pools.size === before) break;
    }
    return [...pools.values()];
  }
}

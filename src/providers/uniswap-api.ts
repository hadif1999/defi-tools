import type { ChainId, Pool, PoolVersion, Position, Protocol } from '../types.js';
import { adapterFor } from '../protocols.js';

export interface ApiClientOptions { endpoint: string; apiKey?: string; fetcher?: typeof fetch }

export class UniswapApiClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: ApiClientOptions) { this.fetcher = options.fetcher ?? fetch; }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { 'x-api-key': this.options.apiKey } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Uniswap API returned HTTP ${response.status}`);
    const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
    if (!body.data) throw new Error('Uniswap API returned no data');
    return body.data;
  }

  async listPools(chainId: ChainId, protocol: PoolVersion | 'all', limit = 50): Promise<Pool[]> {
    // The endpoint/query is intentionally isolated here because Uniswap API schemas evolve independently of the CLI.
    const query = `query Pools($chainId: Int!, $limit: Int!) { pools(chainId: $chainId, first: $limit) { id protocol token0 { id symbol decimals } token1 { id symbol decimals } feeTier tickSpacing hook tvlUsd volume24hUsd fees24hUsd volatility24hPct price tick liquidity } }`;
    const data = await this.request<{ pools?: Array<Record<string, unknown>> }>(query, { chainId, limit });
    return (data.pools ?? []).flatMap((item) => {
      // Rows without a recognizable version are kept only when a specific version was requested.
      const version = (/v[234]/.exec(String(item.protocol ?? '').toLowerCase())?.[0] as PoolVersion | undefined) ?? (protocol === 'all' ? undefined : protocol);
      return version && (protocol === 'all' || version === protocol) ? [this.normalizePool(item, chainId, version)] : [];
    });
  }

  async listPositions(wallet: string, chainId: ChainId, protocol: Protocol): Promise<Position[]> {
    const query = `query Positions($wallet: String!, $chainId: Int!) { positions(owner: $wallet, chainId: $chainId) { id poolId lowerTick upperTick liquidity amount0 amount1 valueUsd } }`;
    const data = await this.request<{ positions?: Array<Record<string, unknown>> }>(query, { wallet, chainId });
    const adapter = adapterFor(protocol);
    return (data.positions ?? []).map((item) => ({ id: required(item.id, 'position id'), wallet, poolId: required(item.poolId, 'position poolId'), chainId, protocol, lowerTick: number(item.lowerTick), upperTick: number(item.upperTick), currentTick: number(item.currentTick), liquidity: string(item.liquidity), amount0: string(item.amount0), amount1: string(item.amount1), valueUsd: number(item.valueUsd), source: 'uniswap-api' as const })).filter(adapter.supportsPosition);
  }

  private normalizePool(item: Record<string, unknown>, chainId: ChainId, protocol: PoolVersion): Pool {
    const token = (value: unknown) => { const x = (value ?? {}) as Record<string, unknown>; return { address: String(x.id ?? x.address ?? ''), symbol: String(x.symbol ?? '?'), decimals: Number(x.decimals ?? 18) }; };
    return { id: required(item.id, 'pool id'), chainId, protocol, token0: token(item.token0), token1: token(item.token1), feeTier: number(item.feeTier), tickSpacing: number(item.tickSpacing), hook: string(item.hook), tvlUsd: number(item.tvlUsd), volume24hUsd: number(item.volume24hUsd), fees24hUsd: number(item.fees24hUsd), volatility24hPct: number(item.volatility24hPct), price: number(item.price), tick: number(item.tick), liquidity: string(item.liquidity), dex: 'Uniswap', source: 'uniswap-api', observedAt: new Date().toISOString() };
  }
}

const number = (value: unknown): number | undefined => value == null || value === '' ? undefined : Number(value);
const string = (value: unknown): string | undefined => value == null ? undefined : String(value);
const required = (value: unknown, field: string): string => {
  if (value == null || String(value).trim() === '') throw new Error(`Malformed Uniswap API response: missing ${field}`);
  return String(value);
};

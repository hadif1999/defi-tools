import { z } from 'zod';
import { isEvmChain, type ChainId, type PoolVersion } from '../types.js';
import { getJson, nonnegative } from './http.js';

// Public API, no key, 300 requests/minute: https://docs.dexscreener.com/api/reference
export const DEXSCREENER_URL = 'https://api.dexscreener.com';
const chainSlugs: Record<ChainId, string> = { 1: 'ethereum', 10: 'optimism', 56: 'bsc', 137: 'polygon', 501: 'solana', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' };
const BATCH = 30; // Addresses per request allowed by the pairs endpoint.
const NATIVE = '0x0000000000000000000000000000000000000000'; // v4 pools can hold native ETH under this address.
const EEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // Curve's placeholder for native ETH.
// DexScreener's dexId for each exchange; Aerodrome appears under both names.
const dexIds: Record<string, string[]> = { Uniswap: ['uniswap'], PancakeSwap: ['pancakeswap'], Aerodrome: ['aerodrome', 'aero'], Curve: ['curve'], Raydium: ['raydium'] };
// Wrapped SOL, USDC and USDT pair with thousands of Solana tokens, so a pool is looked up by its other token when it has one.
const SOLANA_QUOTES = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];

/** EVM addresses are case-insensitive and compared lowercase; Solana addresses are case-sensitive base58 and kept as is. */
export const normalizeAddress = (address: string): string => /^0x/i.test(address) ? address.toLowerCase() : address;
const pairSchema = z.object({
  pairAddress: z.string(),
  dexId: z.string().optional(),
  labels: z.array(z.string()).nullish(),
  baseToken: z.object({ address: z.string() }).optional(),
  quoteToken: z.object({ address: z.string() }).optional(),
  liquidity: z.object({ usd: z.unknown() }).partial().nullish(),
  pairCreatedAt: z.unknown().optional(),
  txns: z.object({ h24: z.object({ buys: z.unknown(), sells: z.unknown() }).partial().optional() }).partial().optional(),
});
type Pair = z.infer<typeof pairSchema>;

export interface PoolDetails { address: string; createdAt?: string; txCount24h?: number; liquidityUsd?: number }

export class DexScreenerClient {
  private readonly fetcher: typeof fetch;
  private readonly tokenPairs = new Map<string, Promise<Pair[]>>();
  constructor(private readonly options: { endpoint?: string; fetcher?: typeof fetch; retryDelayMs?: number } = {}) { this.fetcher = options.fetcher ?? fetch; }

  private async get(path: string): Promise<Pair[]> {
    const body = await getJson(this.fetcher, `${(this.options.endpoint ?? DEXSCREENER_URL).replace(/\/$/, '')}${path}`, 'DexScreener', 15_000, this.options.retryDelayMs);
    // /latest/dex/pairs wraps rows as { pairs }; /token-pairs returns a bare array. Unknown pools give null.
    const rows = Array.isArray(body) ? body : (body as { pairs?: unknown } | null)?.pairs;
    if (rows !== null && rows !== undefined && !Array.isArray(rows)) throw new Error('DexScreener returned an unexpected response.');
    return (rows ?? []).flatMap((row) => { const parsed = pairSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
  }

  /** Creation time and 24h swap count by normalized pool address. Pools DexScreener does not know are absent. */
  async details(chainId: ChainId, addresses: string[]): Promise<Map<string, PoolDetails>> {
    const unique = [...new Set(addresses.map(normalizeAddress))];
    const result = new Map<string, PoolDetails>();
    for (let start = 0; start < unique.length; start += BATCH) {
      for (const pair of await this.get(`/latest/dex/pairs/${chainSlugs[chainId]}/${unique.slice(start, start + BATCH).join(',')}`)) {
        result.set(normalizeAddress(pair.pairAddress), toDetails(pair));
      }
    }
    return result;
  }

  /**
   * Find a pool with no known address (Uniswap v4, Raydium, PancakeSwap, Aerodrome, Curve) by its tokens. Several pools
   * can share a token pair (different fees, hooks or pool types), so the one of the same exchange and type closest in TVL
   * is chosen, and only when within 10%; otherwise nothing is returned. A token's listing holds only its busiest pools,
   * so when the first token's listing has no match, the other token's is tried.
   */
  async findByTokens(chainId: ChainId, dex: string, version: PoolVersion, tokenA: string, tokenB: string, tvlUsd: number | undefined): Promise<PoolDetails | undefined> {
    if (!tvlUsd) return undefined;
    const tokens = [normalizeAddress(tokenA), normalizeAddress(tokenB)];
    // Look up by a non-native token; native ETH has no DexScreener token page. On Solana, prefer tokens other than SOL, USDC and USDT.
    const lookups = isEvmChain(chainId)
      ? tokens.filter((token) => token !== NATIVE && token !== EEE && /^0x[0-9a-f]{40}$/.test(token))
      : [...tokens.filter((token) => token && !SOLANA_QUOTES.includes(token)), ...tokens.filter((token) => SOLANA_QUOTES.includes(token))];
    const listed = (pair: Pair) => {
      if (!pair.dexId || !dexIds[dex]?.includes(pair.dexId)) return false;
      if (dex === 'Uniswap') return Boolean(pair.labels?.includes(version));
      if (dex === 'Raydium') return Boolean(pair.labels?.some((label) => label.toUpperCase() === 'CLMM')) === (version === 'clmm');
      // PancakeSwap labels some pools v2 or v3; others carry no version label.
      return !pair.labels?.some((label) => /^v\d$/i.test(label) && label.toLowerCase() !== version);
    };
    for (const lookup of new Set(lookups)) {
      const key = `${chainId}:${lookup}`;
      if (!this.tokenPairs.has(key)) {
        const request = this.get(`/token-pairs/v1/${chainSlugs[chainId]}/${lookup}`);
        request.catch(() => this.tokenPairs.delete(key));
        this.tokenPairs.set(key, request);
      }
      const candidates = (await this.tokenPairs.get(key)!).filter((pair) => listed(pair)
        && [pair.baseToken?.address, pair.quoteToken?.address].map((address) => normalizeAddress(address ?? '')).sort().join() === [...tokens].sort().join());
      let best: { pair: Pair; gap: number } | undefined;
      for (const pair of candidates) {
        const liquidity = nonnegative(pair.liquidity?.usd);
        if (liquidity === undefined) continue;
        const gap = Math.abs(liquidity - tvlUsd) / tvlUsd;
        if (similarTvl(liquidity, tvlUsd) && (!best || gap < best.gap)) best = { pair, gap };
      }
      if (best) return toDetails(best.pair);
    }
    return undefined;
  }
}

/** Two sources' TVL figures for the same pool agree within 10% (they usually differ by well under 1%). */
export function similarTvl(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && b > 0 && Math.abs(a - b) / b <= 0.1;
}

function toDetails(pair: Pair): PoolDetails {
  const created = nonnegative(pair.pairCreatedAt);
  const buys = nonnegative(pair.txns?.h24?.buys);
  const sells = nonnegative(pair.txns?.h24?.sells);
  return {
    address: normalizeAddress(pair.pairAddress),
    createdAt: created ? new Date(created).toISOString() : undefined,
    txCount24h: buys !== undefined && sells !== undefined ? buys + sells : undefined,
    liquidityUsd: nonnegative(pair.liquidity?.usd),
  };
}

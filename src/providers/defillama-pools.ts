import { z } from 'zod';
import { CHAINS, isEvmChain, type ChainId, type Pool, type PoolSort, type PoolVersion } from '../types.js';
import { sortPools } from '../analytics.js';
import { feeTierFromPercent, getJson, nonnegative } from './http.js';
import { poolAddress } from './pool-address.js';

// Public yields API, no key: https://defillama.com/docs/api (GET /pools lists every tracked pool).
export const DEFILLAMA_URL = 'https://yields.llama.fi';
// Chains missing here have no pools on DefiLlama (e.g. Robinhood Chain); GeckoTerminal covers them.
const chainNames: Partial<Record<ChainId, string[]>> = {
  1: ['Ethereum'], 10: ['OP Mainnet', 'Optimism'], 56: ['BSC'], 137: ['Polygon'], 501: ['Solana'], 8453: ['Base'], 42161: ['Arbitrum'],
};
/** Whether DefiLlama lists pools on this network. */
export const defiLlamaListsChain = (chainId: ChainId): boolean => chainId in chainNames;
// DefiLlama lists all Raydium pools as one project; poolMeta says "Concentrated - 0.25%" (CLMM) or "Standard - 0.25%" (AMM/CPMM).
// v2 pools have one fixed fee and no poolMeta. Aerodrome Slipstream's poolMeta is "CL100 - 0.05%" (tick spacing, fee);
// Aerodrome basic and Curve pools give no fee.
const projects: Record<string, { dex: string; version?: PoolVersion; fee?: number }> = {
  'uniswap-v2': { dex: 'Uniswap', version: 'v2', fee: 3000 }, 'uniswap-v3': { dex: 'Uniswap', version: 'v3' }, 'uniswap-v4': { dex: 'Uniswap', version: 'v4' },
  'pancakeswap-amm': { dex: 'PancakeSwap', version: 'v2', fee: 2500 }, 'pancakeswap-amm-v3': { dex: 'PancakeSwap', version: 'v3' },
  'aerodrome-slipstream': { dex: 'Aerodrome', version: 'clmm' }, 'aerodrome-v1': { dex: 'Aerodrome', version: 'amm' },
  'curve-dex': { dex: 'Curve', version: 'amm' },
  'raydium-amm': { dex: 'Raydium' },
};
const versionOf = (entry: Entry): PoolVersion => projects[entry.project]!.version ?? (/^concentrated/i.test(entry.poolMeta ?? '') ? 'clmm' : 'amm');
const metric = z.unknown().transform(nonnegative);
const entrySchema = z.object({
  pool: z.string().min(1),
  chain: z.string(),
  project: z.string(),
  symbol: z.string().min(1),
  tvlUsd: metric,
  apyBase: metric,
  volumeUsd1d: metric,
  volumeUsd7d: metric,
  poolMeta: z.string().nullish(),
  underlyingTokens: z.array(z.string()).nullish(),
});
type Entry = z.infer<typeof entrySchema>;

export interface DefiLlamaPoolsOptions { endpoint?: string; fetcher?: typeof fetch; timeoutMs?: number; retryDelayMs?: number }

/** DEX pools on a chain (Uniswap as on its Explore page, PancakeSwap, Aerodrome, Curve; Raydium on Solana), with TVL, volume and fee APR. */
export class DefiLlamaPoolsClient {
  private readonly fetcher: typeof fetch;
  private entries?: Promise<Entry[]>;
  constructor(private readonly options: DefiLlamaPoolsOptions = {}) { this.fetcher = options.fetcher ?? fetch; }

  /** The API returns all chains in one large document, so it is fetched once per run and shared. */
  private load(): Promise<Entry[]> {
    this.entries ??= (async () => {
      const url = `${(this.options.endpoint ?? DEFILLAMA_URL).replace(/\/$/, '')}/pools`;
      const body = await getJson(this.fetcher, url, 'DefiLlama', this.options.timeoutMs ?? 60_000, this.options.retryDelayMs);
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) throw new Error('DefiLlama returned an unexpected response (no pool list).');
      // Validate only rows of the listed exchanges, and skip a malformed row rather than failing the whole listing.
      return data.flatMap((row) => {
        if (!(String((row as { project?: unknown })?.project) in projects)) return [];
        const parsed = entrySchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    })();
    this.entries.catch(() => { this.entries = undefined; });
    return this.entries;
  }

  async listPools(chainId: ChainId, versions: readonly PoolVersion[], limit = 25, sorts: readonly PoolSort[] = ['tvl'], matches: (pool: Pool) => boolean = () => true): Promise<Pool[]> {
    const names = chainNames[chainId];
    if (!names) throw new Error(`DefiLlama has no Uniswap pools on ${CHAINS[chainId].name}. Add --source geckoterminal to list them.`);
    const observedAt = new Date().toISOString();
    const pools = (await this.load())
      .filter((entry) => names.includes(entry.chain) && versions.includes(versionOf(entry)) && entry.tvlUsd !== undefined)
      .map((entry) => toPool(entry, chainId, observedAt))
      .filter(matches);
    return sortPools(pools, sorts).slice(0, limit);
  }
}

function toPool(entry: Entry, chainId: ChainId, observedAt: string): Pool {
  const project = projects[entry.project]!;
  const protocol = versionOf(entry);
  const addresses = entry.underlyingTokens ?? [];
  // Symbols are joined by "-", which some token symbols also contain; with token addresses listed, their count must agree.
  const split = entry.symbol.split('-');
  const symbols = split.length === 2 || (split.length > 2 && (!addresses.length || addresses.length === split.length)) ? split : [entry.symbol];
  const [symbol0, symbol1] = symbols.length >= 2 ? symbols : [entry.symbol, '?'];
  const [address0, address1] = addresses;
  // Newer listings round tiny tiers to "0.00%", so those are shown as "<0.01%".
  const prefix = /^(?:concentrated|standard|CL(\d+))\s*-\s*/i.exec(entry.poolMeta?.trim() ?? '');
  const meta = entry.poolMeta?.trim().slice(prefix?.[0].length ?? 0) ?? '';
  const feeTier = project.fee ?? feeTierFromPercent(meta);
  const feeLabel = feeTier !== undefined ? undefined : /dynamic/i.test(meta) ? 'dynamic' : /^0(\.0+)?%$/.test(meta) ? '<0.01%' : undefined;
  return {
    // Only Uniswap's factories are known here; other pools are matched on DexScreener by tokens and TVL.
    id: entry.pool, chainId, protocol, address: isEvmChain(chainId) && project.dex === 'Uniswap' ? poolAddress(chainId, protocol, address0 ?? '', address1 ?? '', feeTier) : undefined,
    name: symbols.length >= 2 ? symbols.join('/') : entry.symbol,
    token0: { address: address0 ?? '', symbol: symbol0! }, token1: { address: address1 ?? '', symbol: symbol1! },
    tokens: symbols.length > 2 ? symbols.map((symbol, index) => ({ address: addresses[index] ?? '', symbol })) : undefined,
    feeTier, feeLabel, tickSpacing: prefix?.[1] ? Number(prefix[1]) : undefined,
    tvlUsd: entry.tvlUsd, volume24hUsd: entry.volumeUsd1d, volume7dUsd: entry.volumeUsd7d,
    fees24hUsd: feeTier !== undefined && entry.volumeUsd1d !== undefined ? entry.volumeUsd1d * feeTier / 1_000_000 : undefined,
    aprPct: entry.apyBase,
    dex: project.dex, source: 'defillama', observedAt,
  };
}

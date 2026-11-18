import { DEFAULT_API_URL, parseChains, parsePositiveInt, parseUsdAmount } from '../config.js';
import { scorePool, sortPools } from '../analytics.js';
import type { PoolFilter } from '../filters.js';
import { poolDex } from '../output.js';
import type { Store } from '../storage.js';
import { UniswapApiClient } from '../providers/uniswap-api.js';
import { PublicPoolsClient } from '../providers/public-pools.js';
import { DefiLlamaPoolsClient, defiLlamaListsChain } from '../providers/defillama-pools.js';
import { RpcProvider } from '../providers/rpc.js';
import { DexScreenerClient, normalizeAddress, similarTvl, type PoolDetails } from '../providers/dexscreener.js';
import { hooklessV4PoolId } from '../providers/pool-address.js';
import { CHAINS, isEvmChain, type AppConfig, type ChainId, type Dex, type Pool, type PoolScore, type PoolSort, type PoolVersion, type Protocol } from '../types.js';
import type { Report } from './wallets.js';

// pools scan / get / rank as one data function, shared by the CLI and the dashboard.

export const DEFAULT_TOP = 25;
export type PoolSource = 'public' | 'geckoterminal' | 'custom';
export type PoolMode = 'scan' | 'get' | 'rank';

export const SOURCE_NAMES: Record<PoolSource, string> = { public: 'DefiLlama public data (no API key)', geckoterminal: 'GeckoTerminal public data (no API key)', custom: 'custom GraphQL provider' };

/** How long a failed v4 pool match is remembered before it is retried. */
const UNMATCHED_RETRY_MS = 24 * 3_600_000;
/** Age filters look up candidates in batches of this size, and check at most this many pools per run. */
const AGE_BATCH = 60;
const MAX_AGE_CANDIDATES = 600;

export function poolSource(options: { source?: PoolSource; apiUrl?: string }, config: AppConfig): PoolSource {
  return options.source ?? ((options.apiUrl ?? config.apiUrl) !== DEFAULT_API_URL ? 'custom' : 'public');
}

/** Native coins also match their wrapped token (ETH and WETH, SOL and WSOL), as the Uniswap app shows WETH as ETH. */
export function tokenSymbols(symbol: string): string[] {
  if (symbol === 'eth' || symbol === 'weth') return ['eth', 'weth'];
  if (symbol === 'sol' || symbol === 'wsol') return ['sol', 'wsol'];
  return [symbol];
}

export const poolTokens = (pool: Pool): Array<{ address: string; symbol: string }> => pool.tokens ?? [pool.token0, pool.token1];

/** Whether a pool token is the lowercased symbol or address the user typed. */
export function isToken(token: { address: string; symbol: string }, query: string): boolean {
  return token.address.toLowerCase() === query || tokenSymbols(query).includes(token.symbol.toLowerCase());
}

/** "WSOL/USDC" → ['wsol', 'usdc']. */
export function parsePair(value: string): [string, string] {
  const parts = value.split('/').map((part) => part.trim().toLowerCase());
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Pair "${value}" needs two tokens joined by /, e.g. defi-tool pools get WSOL/USDC.`);
  return [parts[0]!, parts[1]!];
}

export interface PoolSearchRequest {
  mode: PoolMode;
  /** The pair for get, e.g. WSOL/USDC. */
  pair?: string;
  /** --chain as typed (names, comma-separated, or all). */
  chain?: string;
  protocol: PoolVersion[];
  /** Whether --protocol was given explicitly (a v2 note is only shown then). */
  protocolExplicit?: boolean;
  dex: Dex[];
  sort?: PoolSort[];
  top?: string;
  limit?: string;
  minTvl?: string;
  token?: string;
  filters?: PoolFilter[];
  source?: PoolSource;
  apiUrl?: string;
  /** JSON output: leave out notes meant for people reading a table. */
  quiet?: boolean;
}

export interface PoolSearchResult {
  mode: PoolMode;
  source: PoolSource;
  sourceName: string;
  chains: ChainId[];
  pair?: string;
  filters: PoolFilter[];
  sorts: PoolSort[];
  listing: boolean;
  items: PoolScore[];
  observedAt: string;
}

export interface PoolSearchDeps {
  config: AppConfig;
  store: Store;
  report: Report;
  /** Called once the request is checked, before any download (the CLI prints its header here). */
  onStart?: (info: { source: PoolSource; chains: ChainId[]; pair?: string; filters: PoolFilter[] }) => void;
}

export async function searchPools(request: PoolSearchRequest, { config, store, report, onStart }: PoolSearchDeps): Promise<PoolSearchResult> {
  const { mode } = request;
  const listing = mode !== 'rank';
  const pair = mode === 'get' ? parsePair(request.pair ?? '') : undefined;
  const source = poolSource(request, config);
  // get searches everywhere by default; a wide search skips networks the source does not list instead of failing on them.
  const wide = mode === 'get' && (request.chain === undefined || request.chain.toLowerCase().split(',').some((name) => name.trim() === 'all'));
  const chains = (mode === 'get' ? parseChains(request.chain ?? 'all')! : parseChains(request.chain) ?? config.chains)
    .filter((chain) => !wide || (source === 'public' ? defiLlamaListsChain(chain) : isEvmChain(chain)));
  if (request.top && request.limit) throw new Error('Use either --top or --limit, not both.');
  const limit = parsePositiveInt(request.top ?? request.limit, '--top') ?? DEFAULT_TOP;
  if (source !== 'custom' && limit > 200) throw new Error('--top supports 1 through 200 pools.');
  const minTvl = parseUsdAmount(request.minTvl, '--min-tvl');
  const token: string | undefined = request.token?.trim().toLowerCase();
  if (request.token !== undefined && !token) throw new Error('--token needs a symbol or address, e.g. --token USDC.');
  const versions = request.protocol;
  // GeckoTerminal has no v2 listing: skip v2 when other versions were requested, refuse when it is the only one.
  const geckoVersions = versions.filter((version): version is Protocol => version === 'v3' || version === 'v4');
  if (source === 'geckoterminal' && !geckoVersions.length) throw new Error('The geckoterminal source lists v3 and v4 pools only. Drop --source to use the default source, which includes v2.');
  if (source === 'geckoterminal' && versions.includes('v2') && request.protocolExplicit) report('Note: the geckoterminal source has no v2 pools; showing v3/v4 only.');
  const dexes = request.dex;
  if (source !== 'public' && !dexes.includes('uniswap')) throw new Error(`The ${source} source lists Uniswap pools only. Drop --source to list ${dexes.join(', ')} pools from DefiLlama.`);
  // Solana has only Raydium pools, whose types are clmm and amm; say when it is left empty.
  if (!request.quiet && chains.some((chain) => !isEvmChain(chain))) {
    if (!versions.some((version) => version === 'clmm' || version === 'amm')) report(`Note: no Solana pools, because Raydium pools are clmm or amm and --protocol is ${versions.join(',')}. Add clmm,amm or use --protocol all.`);
    else if (!dexes.includes('raydium')) report('Note: no Solana pools, because Solana pools are Raydium pools and --dex leaves out raydium.');
  }
  const sorts: PoolSort[] = request.sort ?? ['tvl'];
  const filters: PoolFilter[] = request.filters ?? [];
  // Age is not in the listings; those filters run after it is looked up for candidate pools.
  const listingFilters = filters.filter((filter) => !filter.needsDetails);
  const detailFilters = filters.filter((filter) => filter.needsDetails);
  const matches = (pool: Pool): boolean => (minTvl === undefined || (pool.tvlUsd ?? 0) >= minTvl) && listingFilters.every((filter) => filter.matches(pool))
    && dexes.includes(poolDex(pool).toLowerCase() as Dex)
    && (token === undefined || poolTokens(pool).some((t) => isToken(t, token)))
    // Pools with more than two tokens (Curve) match when any two of them form the pair.
    && (pair === undefined || poolTokens(pool).some((a, i) => isToken(a, pair[0]) && poolTokens(pool).some((b, j) => i !== j && isToken(b, pair[1]))));
  const llama = new DefiLlamaPoolsClient({ endpoint: request.apiUrl });
  const gecko = new PublicPoolsClient({ endpoint: request.apiUrl });
  const custom = new UniswapApiClient({ endpoint: request.apiUrl ?? config.apiUrl, apiKey: config.apiKey });
  const dexscreener = new DexScreenerClient({ endpoint: process.env.DEFI_TOOL_DEXSCREENER_URL });
  // Candidates per chain, already filtered. A chain's top N under the same order contains its share of the overall top N,
  // so scan can trim per chain; rank orders by score, so it keeps every candidate.
  const discover = async (chain: ChainId): Promise<Pool[]> => {
    if (!isEvmChain(chain) && source !== 'public') throw new Error(`The ${source} source lists Uniswap pools only. Drop --source to list Raydium pools from DefiLlama.`);
    if (source === 'public' || !isEvmChain(chain)) return llama.listPools(chain, versions, listing && !detailFilters.length ? limit : Infinity, sorts, matches);
    const found = source === 'custom' ? await custom.listPools(chain, versions.length === 1 ? versions[0]! : 'all', limit)
      : (await Promise.all(geckoVersions.map((version) => gecko.listPools(chain, version, limit, sorts[0])))).flat();
    return found.filter((pool) => versions.includes(pool.protocol) && matches(pool));
  };
  onStart?.({ source, chains, pair: request.pair?.trim(), filters });
  const rpc = new RpcProvider(config.rpcUrls);
  let failures = 0;
  const found = (await Promise.all(chains.map(async (chain) => {
    try {
      return await discover(chain);
    } catch (error) {
      failures += 1;
      report(`${CHAINS[chain].name}: ${(error as Error).message}`);
      return [];
    }
  }))).flat();
  if (failures === chains.length) throw new Error(source === 'custom' ? 'Custom pool discovery failed. Check your provider endpoint and access settings.' : 'Pool discovery failed on every selected network; see the messages above. For network errors, check connectivity or retry in a minute.');
  // --top cuts the final merged list; only the pools shown are enriched over RPC and saved.
  const ranked = listing
    ? sortPools(found, sorts).map(scorePool)
    : found.map(scorePool).sort((a, b) => b.score - a.score || (b.pool.tvlUsd ?? 0) - (a.pool.tvlUsd ?? 0));
  // Look up age/txns for the top candidates. With an age filter, keep checking in order until --top pools
  // match, up to MAX_AGE_CANDIDATES; cached ages make repeat runs cheap.
  const selected: PoolScore[] = [];
  const errors = new Set<string>();
  let checked = 0;
  while (selected.length < limit && checked < ranked.length && (!detailFilters.length || checked < MAX_AGE_CANDIDATES) && !(detailFilters.length && errors.size)) {
    const batch = ranked.slice(checked, checked + (detailFilters.length ? AGE_BATCH : limit));
    checked += batch.length;
    const result = await addPoolDetails(batch.map((item) => item.pool), dexscreener, store);
    result.errors.forEach((error) => errors.add(error));
    batch.forEach((item, index) => { if (detailFilters.every((filter) => filter.matches(result.pools[index]!))) selected.push({ ...item, pool: result.pools[index]! }); });
  }
  if (errors.size) report(`Some pool ages and 1D txns are unavailable: ${[...errors].join(' ')}${detailFilters.length ? ' The age filter used cached ages only.' : ''}`);
  if (detailFilters.length && selected.length < limit && checked < ranked.length && !errors.size) {
    report(`Age filter: checked the first ${checked} of ${ranked.length} candidate pools and found ${selected.length}. Narrow other filters (e.g. --min-tvl, --token) to search further.`);
  }
  const items = await Promise.all(selected.slice(0, limit).map(async (item) => ({ ...item, pool: await rpc.enrichPool(item.pool) })));
  store.savePools(items.map((item) => item.pool));
  return { mode, source, sourceName: SOURCE_NAMES[source], chains, pair: request.pair?.trim(), filters, sorts, listing, items, observedAt: new Date().toISOString() };
}

/**
 * Add pool age and 24h swap count from DexScreener to the pools being shown. v2/v3 pools are looked up by
 * address; Uniswap v4 pools by their likely ID, then by tokens and TVL; other pools without an address (Raydium, PancakeSwap, Aerodrome, Curve) by tokens and TVL. Pool addresses and creation times never change,
 * so they are cached in the local database: later runs skip v4 matching and still show age if DexScreener is down.
 * Only the 24h swap count is fetched every time. These columns are extras: a failure leaves them empty rather than
 * failing the command; the messages are returned for the caller to report.
 */
export async function addPoolDetails(found: Pool[], client: DexScreenerClient, store: Store): Promise<{ pools: Pool[]; errors: string[] }> {
  const cacheKey = (pool: Pool) => `${pool.chainId}:${pool.protocol}:${(pool.address ?? pool.id).toLowerCase()}`;
  const cache = store.poolIdentities(found.map(cacheKey));
  const cached = (pool: Pool) => cache.get(cacheKey(pool));
  const known = (pool: Pool) => pool.address ?? (/^0x[0-9a-f]{64}$/i.test(pool.id) ? pool.id : cached(pool)?.address);
  // Pools without an address (Uniswap v4, other exchanges) are searched by tokens; one that recently failed to match is not
  // searched again until the retry interval passes. DexScreener lists two-token pairs, so larger Curve pools are not searched.
  const uniswapV4 = (pool: Pool) => pool.protocol === 'v4' && poolDex(pool) === 'Uniswap';
  const searchable = (pool: Pool) => {
    const entry = cached(pool);
    return (uniswapV4(pool) || poolDex(pool) !== 'Uniswap') && !pool.tokens && !known(pool) && !(entry && Date.now() - Date.parse(entry.checkedAt) < UNMATCHED_RETRY_MS);
  };
  // v4 rows from DefiLlama have no ID; first try the ID of a hookless pool, confirmed below by TVL.
  const guessed = (pool: Pool) => uniswapV4(pool) && searchable(pool) ? hooklessV4PoolId(pool.token0.address, pool.token1.address, pool.feeTier) : undefined;
  const key = (pool: Pool) => known(pool) ?? guessed(pool);
  const byChain = new Map<ChainId, string[]>();
  for (const pool of found) {
    const address = key(pool);
    if (address) byChain.set(pool.chainId, [...(byChain.get(pool.chainId) ?? []), address]);
  }
  const details = new Map<string, PoolDetails>();
  const errors = new Set<string>();
  const attempt = async (task: () => Promise<void>) => { try { await task(); } catch (error) { errors.add((error as Error).message); } };
  await Promise.all([...byChain].map(([chain, addresses]) => attempt(async () => {
    for (const [address, detail] of await client.details(chain, addresses)) details.set(`${chain}:${address}`, detail);
  })));
  const lookup = (pool: Pool): PoolDetails | undefined => {
    const address = key(pool);
    const detail = address ? details.get(`${pool.chainId}:${normalizeAddress(address)}`) : undefined;
    return detail && (!guessed(pool) || similarTvl(detail.liquidityUsd, pool.tvlUsd)) ? detail : undefined;
  };
  // Remaining rows without an address: match by tokens and TVL. A failed request leaves the row out of the map, so it is not cached as unmatched.
  const searched = new Map<Pool, PoolDetails | undefined>();
  await Promise.all(found.filter((pool) => searchable(pool) && !lookup(pool)).map((pool) => attempt(async () => {
    searched.set(pool, await client.findByTokens(pool.chainId, poolDex(pool), pool.protocol, pool.token0.address, pool.token1.address, pool.tvlUsd));
  })));
  // A matched pool belongs to one row only: the row closest to it in TVL.
  const owner = new Map<string, Pool>();
  const gap = (pool: Pool, detail: PoolDetails) => Math.abs((detail.liquidityUsd ?? Infinity) - (pool.tvlUsd ?? 0));
  for (const [pool, detail] of searched) {
    const current = detail && owner.get(detail.address);
    if (detail && (!current || gap(pool, detail) < gap(current, detail))) owner.set(detail.address, pool);
  }
  const pools = found.map((pool) => {
    const matched = searched.get(pool);
    const detail = lookup(pool) ?? (matched && owner.get(matched.address) === pool ? matched : undefined);
    const address = pool.address ?? detail?.address ?? cached(pool)?.address;
    const createdAt = cached(pool)?.createdAt ?? detail?.createdAt ?? pool.createdAt;
    if (detail) store.savePoolIdentity(cacheKey(pool), detail.address, createdAt);
    else if (searched.has(pool)) store.savePoolIdentity(cacheKey(pool), undefined, undefined);
    return { ...pool, address, createdAt, txCount24h: detail?.txCount24h ?? pool.txCount24h };
  });
  return { pools, errors: [...errors] };
}

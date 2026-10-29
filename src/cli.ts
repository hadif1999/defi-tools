#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';
import { loadConfig, parseChains, parseChoice, parsePoolSorts, parsePoolVersions, parseDexes, parseWallets, parsePositiveInt, parseUsdAmount, DEFAULT_API_URL, DEFAULT_CONFIG_PATH, DEFAULT_DATABASE_PATH } from './config.js';
import { runSetup } from './setup.js';
import { commandHelp } from './help.js';
import { FILTER_COLUMNS, parseFilters, type PoolFilter } from './filters.js';
import { scorePool, sortPools, analyzePosition, buildAlerts } from './analytics.js';
import { Store } from './storage.js';
import { UniswapApiClient } from './providers/uniswap-api.js';
import { PublicPoolsClient } from './providers/public-pools.js';
import { DefiLlamaPoolsClient, defiLlamaListsChain } from './providers/defillama-pools.js';
import { RpcProvider } from './providers/rpc.js';
import { DexScreenerClient, normalizeAddress, similarTvl, type PoolDetails } from './providers/dexscreener.js';
import { hooklessV4PoolId } from './providers/pool-address.js';
import { poolDex, printCreatePlan, printPoolList, printPools, printPositions, printPositionTables, printWallets, type Signer } from './output.js';
import { parseAmount, parseDeadline, parseLimit, planPosition } from './create-position.js';
import { CREATE_CHAINS } from './providers/tokens.js';
import { walletBalances } from './providers/balances.js';
import { RevertClient } from './providers/revert.js';
import { loadPortfolio, splitPositions, type PositionSource, type WalletGroup } from './positions.js';
import { CHAINS, DEXES, SOLANA, POOL_SORTS, POOL_VERSIONS, isEvmChain, type AppConfig, type Dex, type EvmChainId, type PoolScore, type ChainId, type Pool, type PoolSort, type PoolVersion, type PositionAnalysis, type Protocol, type SavedWallet } from './types.js';

const DEFAULT_TOP = 25;

const app = new Command().name('defi-tool')
  .description('Find Uniswap, PancakeSwap, Aerodrome, Curve and Raydium pools and check the health of your Uniswap LP positions. All commands are read-only.')
  .version('0.1.0').option('--config <file>', 'use a different configuration file')
  .configureHelp({ showGlobalOptions: true }).showSuggestionAfterError(true)
  .showHelpAfterError('Run defi-tool --help, or add --help after any command for examples.');
const configPath = (): string => app.opts().config ?? process.env.DEFI_TOOL_CONFIG ?? DEFAULT_CONFIG_PATH;
commandHelp(app, ['defi-tool init', 'defi-tool chains', 'defi-tool pools scan --chain eth', 'defi-tool pools get WSOL/USDC', 'defi-tool wallet add 0xYourWallet --chain eth --name main', 'defi-tool positions list --wallet main'], [
  'No API key or setup is needed for public data. wallet add saves wallets by name; init optionally saves networks and settings.',
  'Add --help to any command, e.g. defi-tool positions analyze --help.',
  `Use --json on data commands for scripts. Chain names: ${Object.values(CHAINS).map((chain) => chain.slug).join(', ')}, all.`,
]);
app.action(() => app.outputHelp());

const init = app.command('init').description('Optionally save wallets, networks, and local settings. No API key needed.')
  .option('--api-key <key>', 'optional credential for a custom provider; never used by public sources')
  .option('--api-url <url>', 'optional custom GraphQL endpoint', DEFAULT_API_URL)
  .option('--database <path>', 'SQLite database path', DEFAULT_DATABASE_PATH)
  .option('--wallet <addresses>', 'wallet address, or comma-separated addresses')
  .addOption(new Option('--wallets <addresses>', 'alias for --wallet').hideHelp())
  .option('--chain <names>', 'networks to save, e.g. eth,arb or all')
  .option('--force', 'replace existing configuration (resets saved settings)');
commandHelp(init, ['defi-tool init', 'defi-tool init --wallet 0xYourWallet --chain eth,base', 'defi-tool --config ./config.json init --chain arb'], [
  'Interactive in a terminal. Scripts can pass flags; missing values use defaults.',
  `Configuration: ${DEFAULT_CONFIG_PATH} (override with --config or DEFI_TOOL_CONFIG).`,
  'Existing configuration is protected unless --force is supplied.',
  'Public pools and direct RPC position reads do not require API keys.',
  `RPC URLs can also come from ${(Object.keys(CHAINS).map(Number) as ChainId[]).filter(isEvmChain).map((chain) => `RPC_URL_${CHAINS[chain].slug.toUpperCase()}`).join(', ')}.`,
]);
init.action((options) => runSetup(options, configPath()));

const chainsCommand = app.command('chains').description('List supported networks, aliases, and RPC settings.');
commandHelp(chainsCommand, ['defi-tool chains', 'defi-tool pools rank --chain eth,base', 'defi-tool positions list --chain all'], [
  'Chain names are case-insensitive; legacy numeric chain IDs still work.',
  'Robinhood Chain pools come from GeckoTerminal: add --source geckoterminal (DefiLlama does not list them).',
  'Solana lists Raydium pools (pools scan/rank only, default source); positions and alerts are Uniswap on EVM chains.',
]);
chainsCommand.action(() => {
  console.table(Object.entries(CHAINS).map(([id, chain]) => ({ chain: chain.name, name: chain.slug, aliases: chain.aliases.join(', ') || '—', id, dexes: chain.dexes.join(', '), rpc: isEvmChain(Number(id) as ChainId) ? `RPC_URL_${chain.slug.toUpperCase()}` : '—' })));
  console.log('Use --chain eth,arb or --chain all. For Robinhood Chain pools, add --source geckoterminal. Solana (Raydium) is for pool listings only.');
});

/** A fixed-choice option that accepts any letter case (V3, Public) and still lists its choices in help. */
function choiceOption(flags: string, description: string, choices: readonly string[]): Option {
  const option = new Option(flags, description).choices(choices);
  return option.argParser((value: string) => {
    try { return parseChoice(value, choices, option.long ?? flags); } catch (error) { throw new InvalidArgumentError((error as Error).message); }
  });
}

const dataOptions = (command: Command): Command => command
  .addOption(choiceOption('--protocol <version>', 'Uniswap position version', ['v3', 'v4']).default('v3'))
  .option('--chain <names>', 'networks, e.g. eth,arb,base or all (default: saved chains)')
  .addOption(choiceOption('--source <provider>', 'public = no keys; custom = configured GraphQL provider (default: public unless a custom URL is configured)', ['public', 'custom']))
  .option('--api-url <url>', 'override provider URL; selects custom GraphQL unless --source public is supplied')
  .option('--json', 'print structured JSON instead of tables or messages');

const pools = app.command('pools').description('List DEX pools (Uniswap like app.uniswap.org/explore/pools, PancakeSwap, Aerodrome, Curve; Raydium on Solana), or rank them by opportunity score.');
commandHelp(pools, ['defi-tool pools scan --chain eth', 'defi-tool pools scan --chain base --sort volume --top 10', 'defi-tool pools get WSOL/USDC', 'defi-tool pools rank --chain eth,arb --top 10'], [
  'scan lists pools by TVL, volume, or APR, like the Uniswap Explore page. get lists one token pair on every network and DEX. rank orders pools by a heuristic score.',
]);
pools.action(() => pools.outputHelp());
for (const action of ['scan', 'get', 'rank'] as const) {
  // get is scan narrowed to one token pair, searched on every network unless --chain says otherwise.
  const listing = action !== 'rank';
  const command = pools.command(action)
    .description({ scan: 'List pools with TVL, volume, vol/TVL, and APR, like the Uniswap Explore page.', get: 'List the pools for one token pair, e.g. WSOL/USDC, on every network and DEX.', rank: 'Rank pools by a heuristic opportunity score; inspect confidence before choosing.' }[action]);
  if (action === 'get') command.argument('<pair>', 'two tokens joined by /, e.g. WSOL/USDC or ETH/USDC: symbols or addresses, in either order');
  command
    .option('--chain <names>', `networks, e.g. eth,arb,base or all (default: ${action === 'get' ? 'all' : 'saved chains'})`)
    .addOption(new Option('--protocol <versions>', 'pool types to include, comma-separated, e.g. v3,v2: v2, v3, v4 (Uniswap, PancakeSwap); clmm (Raydium CLMM, Aerodrome Slipstream); amm (Raydium AMM, Aerodrome basic, Curve) (default: all)')
      .argParser((value: string) => { try { return parsePoolVersions(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
      .default([...POOL_VERSIONS], 'all'))
    .addOption(new Option('--dex <names>', `exchanges to include, comma-separated: ${DEXES.join(', ')} (default: all)`)
      .argParser((value: string) => { try { return parseDexes(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
      .default([...DEXES], 'all'));
  if (listing) {
    command.addOption(new Option('--sort <metrics>', `order, highest first; comma-separate keys to break ties, e.g. tvl,apr (keys: ${POOL_SORTS.join(', ')})`)
      .argParser((value: string) => { try { return parsePoolSorts(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
      .default(['tvl'], 'tvl'));
  }
  command
    .option('--top <count>', `number of pools to show in total, 1-200 (default: ${DEFAULT_TOP})`)
    .addOption(new Option('--limit <count>', 'alias for --top').hideHelp())
    .option('--min-tvl <usd>', 'skip pools with less TVL, e.g. 50000, 250k, or 1m')
    .option('--token <symbol|address>', 'only pools containing this token, e.g. USDC or ETH (ETH also matches WETH)')
    .addOption(new Option('--filter <condition>', `only pools matching a condition, e.g. "apr>10" or "vol/tvl>=1"; repeat or join with commas (columns: ${FILTER_COLUMNS})`)
      .argParser((value: string, previous: PoolFilter[] = []) => { try { return [...previous, ...parseFilters(value)]; } catch (error) { throw new InvalidArgumentError((error as Error).message); } }))
    .addOption(choiceOption('--source <provider>', 'public = DefiLlama, no key (default); geckoterminal = GeckoTerminal, no key, v3/v4 only; custom = your GraphQL endpoint', ['public', 'geckoterminal', 'custom']))
    .option('--api-url <url>', 'override the provider URL; selects custom unless --source is given')
    .option('--json', 'print structured JSON instead of a table');
  commandHelp(command, {
    scan: ['defi-tool pools scan --chain eth', 'defi-tool pools scan --chain base --protocol v4 --sort volume --top 10', 'defi-tool pools scan --chain base,eth --top 50 --protocol v3,v2 --sort tvl,apr', 'defi-tool pools scan --chain eth,arb --token USDC --min-tvl 1m', 'defi-tool pools scan --chain base --filter "apr>10" --filter "vol/tvl>1"', 'defi-tool pools scan --chain solana --protocol clmm --min-tvl 1m', 'defi-tool pools scan --chain eth --json'],
    get: ['defi-tool pools get WSOL/USDC', 'defi-tool pools get ETH/USDC --chain eth,base --protocol v3,v4', 'defi-tool pools get WSOL/USDC --chain all --protocol v3,v4,clmm,amm --top 50 --sort tvl,apr --filter "apr>30" --filter "vol/tvl>0.4" --filter "tvl>1m" --filter "age>6m"', 'defi-tool pools get ETH/USDC --json'],
    rank: ['defi-tool pools rank --chain eth,arb --top 10', 'defi-tool pools rank --chain base --protocol v3 --min-tvl 500k --json'],
  }[action], [
    ...(action === 'get'
      ? ['Matches the pair in either order (USDC/WSOL finds WSOL/USDC); ETH also matches WETH, SOL also matches WSOL.',
        'Without --chain, searches every network the source lists. Takes the same options as pools scan.']
      : ['Without --chain, uses your saved networks (eth, arb, op, base, polygon unless init saved others).']),
    '--top limits the final list across all chains, after filters and sorting. Option values ignore letter case.',
    'Quote --filter conditions so the shell does not treat > as a redirect. Values use table units: APR and fee in %, TVL and volume in USD (250k, 1m).',
    'Age filters take h, d, w, m (months), or y: --filter "age>2m". Pools with unknown age are excluded; ages are looked up only as needed.',
    'Default data: DefiLlama public yields API, no init or API key. 30-day volume is unavailable, so 7D volume is shown.',
    'Default DEXes: Uniswap, PancakeSwap, Aerodrome (Base) and Curve on EVM chains, Raydium on Solana; narrow with --dex, e.g. --dex uniswap,curve. CLMM = concentrated, AMM = standard.',
    '--chain solana lists Raydium pools from DefiLlama; --token SOL also matches WSOL. Aerodrome LPs earn AERO rewards instead of fees, so its APR is often —.',
    'Age and 1D txns come from DexScreener for the pools shown; pools without a known address (Uniswap v4, other DEXes) are matched by tokens and TVL, so some show —.',
    'APR is the last 24h of trading fees annualized against TVL, before the protocol fee; the Uniswap app\'s LP APR can be lower.',
    ...(listing
      ? ['--sort tvl,apr sorts by TVL, then APR among equal TVLs. Exact ties are rare, so later keys mostly matter for volume or missing data.']
      : ['Scores every matching pool (GeckoTerminal: the first --top per version and chain). Scores are heuristics, not guaranteed yields.']),
  ]);
  command.action(async () => {
    const options = command.opts();
    const pair = action === 'get' ? parsePair(command.args[0]!) : undefined;
    const config = await loadConfig(configPath());
    const source = poolSource(options, config);
    // get searches everywhere by default; a wide search skips networks the source does not list instead of failing on them.
    const wide = action === 'get' && (options.chain === undefined || options.chain.toLowerCase().split(',').some((name: string) => name.trim() === 'all'));
    const chains = (action === 'get' ? parseChains(options.chain ?? 'all')! : parseChains(options.chain) ?? config.chains)
      .filter((chain) => !wide || (source === 'public' ? defiLlamaListsChain(chain) : isEvmChain(chain)));
    if (options.top && options.limit) throw new Error('Use either --top or --limit, not both.');
    const limit = parsePositiveInt(options.top ?? options.limit, '--top') ?? DEFAULT_TOP;
    if (source !== 'custom' && limit > 200) throw new Error('--top supports 1 through 200 pools.');
    const minTvl = parseUsdAmount(options.minTvl, '--min-tvl');
    const token: string | undefined = options.token?.trim().toLowerCase();
    if (options.token !== undefined && !token) throw new Error('--token needs a symbol or address, e.g. --token USDC.');
    const versions: PoolVersion[] = options.protocol;
    // GeckoTerminal has no v2 listing: skip v2 when other versions were requested, refuse when it is the only one.
    const geckoVersions = versions.filter((version): version is Protocol => version === 'v3' || version === 'v4');
    if (source === 'geckoterminal' && !geckoVersions.length) throw new Error('The geckoterminal source lists v3 and v4 pools only. Drop --source to use the default source, which includes v2.');
    if (source === 'geckoterminal' && versions.includes('v2') && command.getOptionValueSource('protocol') === 'cli') console.error('Note: the geckoterminal source has no v2 pools; showing v3/v4 only.');
    const dexes: Dex[] = options.dex;
    if (source !== 'public' && !dexes.includes('uniswap')) throw new Error(`The ${source} source lists Uniswap pools only. Drop --source to list ${dexes.join(', ')} pools from DefiLlama.`);
    // Solana has only Raydium pools, whose types are clmm and amm; say when it is left empty.
    if (!options.json && chains.some((chain) => !isEvmChain(chain))) {
      if (!versions.some((version) => version === 'clmm' || version === 'amm')) console.error(`Note: no Solana pools, because Raydium pools are clmm or amm and --protocol is ${versions.join(',')}. Add clmm,amm or use --protocol all.`);
      else if (!dexes.includes('raydium')) console.error('Note: no Solana pools, because Solana pools are Raydium pools and --dex leaves out raydium.');
    }
    const sorts: PoolSort[] = options.sort ?? ['tvl'];
    const filters: PoolFilter[] = options.filter ?? [];
    // Age is not in the listings; those filters run after it is looked up for candidate pools.
    const listingFilters = filters.filter((filter) => !filter.needsDetails);
    const detailFilters = filters.filter((filter) => filter.needsDetails);
    const matches = (pool: Pool): boolean => (minTvl === undefined || (pool.tvlUsd ?? 0) >= minTvl) && listingFilters.every((filter) => filter.matches(pool))
      && dexes.includes(poolDex(pool).toLowerCase() as Dex)
      && (token === undefined || poolTokens(pool).some((t) => isToken(t, token)))
      // Pools with more than two tokens (Curve) match when any two of them form the pair.
      && (pair === undefined || poolTokens(pool).some((a, i) => isToken(a, pair[0]) && poolTokens(pool).some((b, j) => i !== j && isToken(b, pair[1]))));
    const llama = new DefiLlamaPoolsClient({ endpoint: options.apiUrl });
    const gecko = new PublicPoolsClient({ endpoint: options.apiUrl });
    const custom = new UniswapApiClient({ endpoint: options.apiUrl ?? config.apiUrl, apiKey: config.apiKey });
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
    if (!options.json) console.log(`Source: ${sourceNames[source]} · ${chains.map((chain) => CHAINS[chain].name).join(', ')} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    if (!options.json && pair) console.log(`Pair: ${command.args[0]!.trim()} (either token order)`);
    if (!options.json && filters.length) console.log(`Filters: ${filters.map((filter) => filter.text).join(' and ')}`);
    const rpc = new RpcProvider(config.rpcUrls);
    const store = new Store(config.databasePath);
    let failures = 0;
    try {
      const found = (await Promise.all(chains.map(async (chain) => {
        try {
          return await discover(chain);
        } catch (error) {
          failures += 1;
          console.error(`${CHAINS[chain].name}: ${(error as Error).message}`);
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
      if (errors.size) console.error(`Some pool ages and 1D txns are unavailable: ${[...errors].join(' ')}${detailFilters.length ? ' The age filter used cached ages only.' : ''}`);
      if (detailFilters.length && selected.length < limit && checked < ranked.length && !errors.size) {
        console.error(`Age filter: checked the first ${checked} of ${ranked.length} candidate pools and found ${selected.length}. Narrow other filters (e.g. --min-tvl, --token) to search further.`);
      }
      const shown = await Promise.all(selected.slice(0, limit).map(async (item) => ({ ...item, pool: await rpc.enrichPool(item.pool) })));
      store.savePools(shown.map((item) => item.pool));
      // JSON keeps the established { pool, score, ... } shape; the scan table mirrors the Explore page.
      if (listing && !options.json) printPoolList(shown.map((item) => item.pool), { json: false, sorts });
      else printPools(shown, Boolean(options.json));
    } finally { store.close(); }
  });
}

/** How long a failed v4 pool match is remembered before it is retried. */
const UNMATCHED_RETRY_MS = 24 * 3_600_000;
/** Age filters look up candidates in batches of this size, and check at most this many pools per run. */
const AGE_BATCH = 60;
const MAX_AGE_CANDIDATES = 600;

/**
 * Add pool age and 24h swap count from DexScreener to the pools being shown. v2/v3 pools are looked up by
 * address; Uniswap v4 pools by their likely ID, then by tokens and TVL; other pools without an address (Raydium, PancakeSwap, Aerodrome, Curve) by tokens and TVL. Pool addresses and creation times never change,
 * so they are cached in the local database: later runs skip v4 matching and still show age if DexScreener is down.
 * Only the 24h swap count is fetched every time. These columns are extras: a failure is reported on stderr and
 * leaves them empty rather than failing the command; the messages are returned for the caller to report.
 */
async function addPoolDetails(found: Pool[], client: DexScreenerClient, store: Store): Promise<{ pools: Pool[]; errors: string[] }> {
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

const sourceNames = { public: 'DefiLlama public data (no API key)', geckoterminal: 'GeckoTerminal public data (no API key)', custom: 'custom GraphQL provider' } as const;

function poolSource(options: { source?: 'public' | 'geckoterminal' | 'custom'; apiUrl?: string }, config: AppConfig): 'public' | 'geckoterminal' | 'custom' {
  return options.source ?? ((options.apiUrl ?? config.apiUrl) !== DEFAULT_API_URL ? 'custom' : 'public');
}

/** Native coins also match their wrapped token (ETH and WETH, SOL and WSOL), as the Uniswap app shows WETH as ETH. */
function tokenSymbols(symbol: string): string[] {
  if (symbol === 'eth' || symbol === 'weth') return ['eth', 'weth'];
  if (symbol === 'sol' || symbol === 'wsol') return ['sol', 'wsol'];
  return [symbol];
}

const poolTokens = (pool: Pool): Array<{ address: string; symbol: string }> => pool.tokens ?? [pool.token0, pool.token1];

/** Whether a pool token is the lowercased symbol or address the user typed. */
function isToken(token: { address: string; symbol: string }, query: string): boolean {
  return token.address.toLowerCase() === query || tokenSymbols(query).includes(token.symbol.toLowerCase());
}

/** "WSOL/USDC" → ['wsol', 'usdc']. */
function parsePair(value: string): [string, string] {
  const parts = value.split('/').map((part) => part.trim().toLowerCase());
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Pair "${value}" needs two tokens joined by /, e.g. defi-tool pools get WSOL/USDC.`);
  return [parts[0]!, parts[1]!];
}

const positions = app.command('positions').description('List your Uniswap LP positions (open and closed), check their ranges, or plan a new one.');
commandHelp(positions, ['defi-tool positions list', 'defi-tool positions create WETH/USDC --chain base --wallet main --amount 100usd --lower-limit -15% --upper-limit +10%', 'defi-tool positions list --wallet wallet0', 'defi-tool positions list --wallet-addr 0xYourWallet --past', 'defi-tool positions analyze --wallet 0xYourWallet --chain eth'], [
  'list shows open and closed positions with prices, ranges, balances, fees, APR and PnL. analyze checks range status only (used by alerts).',
  'create builds the transactions for a new v3 position on Base or Arbitrum for your wallet to sign; it never signs or sends.',
  'Uses wallets saved with defi-tool wallet add (each on its network) or init, or pass --wallet; list also takes --wallet-addr. ls is an alias for list.',
]);
positions.action(() => positions.outputHelp());
const list = positions.command('list').alias('ls')
  .description('Show open and closed Uniswap positions with price, range, balance, fees earned, APR and PnL, as two tables.')
  .option('--wallet <names>', 'saved wallet name(s), comma-separated; each is read on its saved network (default: all saved wallets)')
  .option('--wallet-addr <addresses>', 'wallet address(es), comma-separated; read on every network unless --chain is given')
  .option('--chain <names>', 'only these networks, e.g. eth,base (default: each saved wallet\'s network; every network for --wallet-addr)')
  .option('--active', 'show only open positions')
  .option('--past', 'show only closed positions')
  .option('--top <count>', 'rows per table, 1-1000 (default: 100)')
  .addOption(choiceOption('--source <provider>', 'auto = Revert Finance, falling back to on-chain reads; revert; rpc = on-chain only (no history)', ['auto', 'revert', 'rpc']).default('auto'))
  .option('--json', 'print structured JSON instead of tables');
commandHelp(list, ['defi-tool positions list', 'defi-tool positions list --wallet my-wallet1', 'defi-tool positions list --wallet-addr 0xYourWallet', 'defi-tool positions list --wallet-addr 0xYourWallet --chain base --past --top 10', 'defi-tool positions list --active --json'], [
  'Open positions still provide liquidity; closed ones have withdrawn it all. Both are shown unless --active or --past is given.',
  'Data: Revert Finance\'s public positions API (no key), which keeps each position\'s deposits, withdrawals, fees and PnL.',
  'If it is unreachable, position NFTs the wallet still holds are read over RPC instead, with prices from DefiLlama but no history.',
  'Prices use a stablecoin or the wrapped native coin as the quote when the pair has one, e.g. USDC per WETH.',
  'Solana wallets are skipped: positions are Uniswap NFTs on EVM networks. No private key is ever needed.',
]);
list.action(async (options: { wallet?: string; walletAddr?: string; chain?: string; active?: boolean; past?: boolean; top?: string; source: PositionSource; json?: boolean }) => {
  const config = await loadConfig(configPath());
  const top = parsePositiveInt(options.top, '--top') ?? 100;
  if (top > 1000) throw new Error('--top supports 1 through 1000 positions per table.');
  const store = new Store(config.databasePath);
  try {
    const groups = walletGroups(options.wallet, options.walletAddr, parseChains(options.chain), config, store);
    if (!groups.length) throw new Error('No wallets to read. Save one with defi-tool wallet add 0xYourWallet --chain eth, or pass --wallet-addr 0xYourWallet.');
    const rpc = new RpcProvider(config.rpcUrls);
    const revert = new RevertClient({ endpoint: process.env.DEFI_TOOL_REVERT_URL });
    const result = await loadPortfolio(groups, options.source, { revert, rpc, pricesUrl: process.env.DEFI_TOOL_PRICES_URL }, (message) => console.error(message));
    store.savePositions(result.positions.filter((position) => position.active).map((position) => ({
      id: position.id, wallet: position.wallet, poolId: position.pool ?? '', chainId: position.chainId, protocol: position.protocol, lowerTick: position.tickLower, upperTick: position.tickUpper,
      currentTick: position.currentTick, liquidity: position.liquidity, valueUsd: position.valueUsd, source: position.source,
    })));
    const { active, past } = splitPositions(result.positions);
    const both = Boolean(options.active) === Boolean(options.past);
    const sources = new Set(result.positions.map((position) => position.source));
    printPositionTables(active, past, {
      json: Boolean(options.json), showActive: both || Boolean(options.active), showPast: both || Boolean(options.past), top,
      scope: groups.map(groupLabel),
      source: sources.has('rpc') ? (sources.has('revert') ? 'Revert Finance and on-chain RPC (no API key)' : 'on-chain RPC and DefiLlama prices (no API key)') : 'Revert Finance (no API key)',
    });
  } finally { store.close(); }
});

const analyze = dataOptions(positions.command('analyze')
  .description('Check whether price is inside each position\'s liquidity range.')
  .option('--wallet <names|addresses>', 'saved wallet name(s) or address(es), separated by commas (default: saved wallets)')
  .option('--position <ids>', 'specific NFT token ID(s), comma-separated; required for public v4 reads'));
commandHelp(analyze, ['defi-tool positions analyze', 'defi-tool positions analyze --wallet my-wallet1', 'defi-tool positions analyze --wallet 0xYourWallet --chain eth,arb', 'defi-tool positions analyze --wallet 0xYourWallet --protocol v4 --chain base --position 123 --json'], [
  'A saved wallet is checked on its own network unless --chain is given; an address uses --chain or the networks saved by init.',
  'Near a boundary means within 10% of the tick range by default; configure saturationThresholdPct to change it.',
  'Public v3 discovery uses RPC, without keys. Public v4 requires --position and one wallet/network.',
  'Public RPC defaults are included; custom RPC_URL_* values are optional. Zero-liquidity NFTs are skipped.',
  'RPC-only reads provide range status and liquidity; USD value, amounts, and earned fees are not computed.',
]);

const create = positions.command('create')
  .description('Plan a new Uniswap v3 position and build its transactions for your wallet to sign. Nothing is signed or sent.')
  .argument('[pair]', 'two tokens joined by /, e.g. WETH/USDC (symbols or addresses; ETH means WETH)')
  .requiredOption('--chain <name>', `network: ${CREATE_CHAINS.map((chain) => CHAINS[chain].slug).join(' or ')}`)
  .requiredOption('--wallet <name|address>', 'saved wallet name or 0x address that will sign, pay and receive the position NFT')
  .requiredOption('--amount <amount>', 'deposit: a USD total (100usd, $100), one token\'s amount (0.05weth, 150usdc; the other token follows from the range), or max')
  .option('--lower-limit <limit>', 'lower end of the range: percent from the current price (-15%) or a price in the shown unit (2100)')
  .option('--upper-limit <limit>', 'upper end of the range: percent from the current price (+10%) or a price (2600)')
  .option('--full-range', 'provide liquidity at every price instead of --lower-limit/--upper-limit')
  .option('--fee <percent>', 'fee tier in percent: 0.01, 0.05, 0.3 or 1 (default: the pool with the most liquidity)')
  .option('--pool <address>', 'a v3 pool address instead of the pair and --fee')
  .option('--slippage <percent>', 'price move tolerated before the mint lands, in percent (default: 0.5)', '0.5')
  .option('--deadline <time>', 'how long the mint stays valid after it is built, e.g. 20m or 1h (default: 20m)', '20m')
  .addOption(choiceOption('--pay-with <token>', 'auto = WETH, or native ETH when the wallet lacks WETH; weth; eth', ['auto', 'weth', 'eth']).default('auto'))
  .addOption(choiceOption('--approve <amount>', 'exact = approve only what this mint needs (safer); unlimited', ['exact', 'unlimited']).default('exact'))
  .addOption(choiceOption('--signer <wallet>', 'mm = print MetaMask agent wallet (mm) commands; raw = print to/value/data for any wallet', ['mm', 'raw']).default('mm'))
  .option('--json', 'print the plan as JSON');
commandHelp(create, [
  'defi-tool positions create WETH/USDC --chain base --wallet my-wallet --amount 100usd --lower-limit -15% --upper-limit +10%',
  'defi-tool positions create WETH/USDC --chain arb --fee 0.05 --wallet 0xYourWallet --amount 0.05weth --lower-limit 2000 --upper-limit 2700',
  'defi-tool positions create cbBTC/USDC --chain base --wallet my-wallet --amount max --lower-limit -20% --upper-limit +20% --signer raw',
  'defi-tool positions create --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --wallet my-wallet --amount 50usd --full-range --json',
], [
  'Read-only: the command reads the pool and wallet on-chain, then prints the approve and mint transactions to sign, in order. It never signs or sends.',
  'Limits need not be symmetric. Percentages are from the current price in the unit shown (e.g. USDC per WETH); ticks are widened to the pool\'s tick spacing.',
  'Approvals are only added when the allowance is short. After signing them, run the command again so the mint uses the latest price and is simulated first.',
  'The mint is simulated from your wallet when it can run now; a failing simulation shows the revert reason. Minimum amounts protect against --slippage.',
  'A volatility check from 30 days of prices estimates how soon a typical move leaves the range. Only Base and Arbitrum, Uniswap v3, for now.',
  'Ledger wallet-cli cannot send contract calls on Base or Arbitrum; use mm, or --signer raw with a wallet that can.',
]);
create.action(async (pair: string | undefined, options: { chain: string; wallet: string; amount: string; lowerLimit?: string; upperLimit?: string; fullRange?: boolean; fee?: string; pool?: string; slippage: string; deadline: string; payWith: 'auto' | 'weth' | 'eth'; approve: 'exact' | 'unlimited'; signer: Signer; json?: boolean }) => {
  const config = await loadConfig(configPath());
  const chainId = parseWalletChain(options.chain);
  if (!isEvmChain(chainId) || !CREATE_CHAINS.includes(chainId)) throw new Error(`positions create supports ${CREATE_CHAINS.map((chain) => CHAINS[chain].name).join(' and ')} for now.`);
  if (Boolean(pair) === Boolean(options.pool)) throw new Error('Give a pair such as WETH/USDC, or --pool <address>, but not both.');
  if (options.pool && !/^0x[0-9a-fA-F]{40}$/.test(options.pool)) throw new Error('--pool must be a 0x pool address.');
  if (options.fee !== undefined && options.pool) throw new Error('--fee is implied by --pool; leave it out.');
  const fees: Record<string, number> = { '0.01': 100, '0.05': 500, '0.3': 3000, '0.30': 3000, '1': 10_000, '1.0': 10_000 };
  const feeTier = options.fee === undefined ? undefined : fees[options.fee.trim().replace(/%$/, '')];
  if (options.fee !== undefined && feeTier === undefined) throw new Error(`--fee "${options.fee}" is not a Uniswap v3 tier: use 0.01, 0.05, 0.3 or 1.`);
  if (options.fullRange && (options.lowerLimit || options.upperLimit)) throw new Error('Use --full-range or --lower-limit/--upper-limit, not both.');
  if (!options.fullRange && (!options.lowerLimit || !options.upperLimit)) throw new Error('Give both --lower-limit and --upper-limit (e.g. --lower-limit -15% --upper-limit +10%), or --full-range.');
  const slippage = Number(options.slippage.replace(/%$/, ''));
  if (!(slippage > 0 && slippage <= 50)) throw new Error('--slippage must be a percentage above 0 and at most 50, e.g. 0.5.');
  const store = new Store(config.databasePath);
  let wallet: string;
  try {
    const saved = store.wallet(options.wallet);
    if (saved && !isEvmChain(saved.chainId)) throw new Error(`Saved wallet "${saved.name}" is a Solana wallet; positions are on EVM networks.`);
    wallet = saved?.address ?? options.wallet.trim();
  } finally { store.close(); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error(`--wallet "${options.wallet}" is neither a saved wallet name nor a 0x address.`);
  const plan = await planPosition({
    chainId, pair: pair ? parsePair(pair) : undefined, pool: options.pool, feeTier,
    lower: options.lowerLimit ? parseLimit(options.lowerLimit, '--lower-limit') : undefined,
    upper: options.upperLimit ? parseLimit(options.upperLimit, '--upper-limit') : undefined,
    fullRange: options.fullRange, amount: parseAmount(options.amount), wallet, slippage: slippage / 100,
    deadlineSeconds: parseDeadline(options.deadline), payWith: options.payWith, approve: options.approve, pricesUrl: process.env.DEFI_TOOL_PRICES_URL,
  }, new RpcProvider(config.rpcUrls), (message) => console.error(message));
  printCreatePlan(plan, { json: Boolean(options.json), signer: options.signer });
});

const alerts = app.command('alerts').description('Check and persist actionable position alerts.');
commandHelp(alerts, ['defi-tool alerts check', 'defi-tool alerts check --wallet 0xYourWallet --chain eth', 'defi-tool alerts check --help'], [
  'Checks run when you request them; there is no background monitoring process.',
]);
alerts.action(() => alerts.outputHelp());
const check = dataOptions(alerts.command('check')
  .description('Check wallet positions and report new boundary or out-of-range alerts.')
  .option('--wallet <names|addresses>', 'saved wallet name(s) or address(es), separated by commas (default: saved wallets)')
  .option('--position <ids>', 'specific NFT token ID(s), comma-separated; required for public v4 reads'));
commandHelp(check, ['defi-tool alerts check', 'defi-tool alerts check --wallet my-wallet1', 'defi-tool alerts check --wallet 0xYourWallet --chain eth,arb', 'defi-tool alerts check --wallet 0xYourWallet --chain base --protocol v4 --position 123 --json'], [
  'Exit codes: 0 = no new alerts, 2 = new alerts found, 1 = command failed.',
  'Repeated alerts for the same status are suppressed using the local database.',
  'Unknown range status is not an all-clear. Use positions analyze to inspect missing data.',
  'No API key required. Public v4 requires --position and a single wallet/network.',
]);

// Position analysis and alerts share the same discovery and RPC error handling.
for (const command of [analyze, check]) command.action(async (options) => {
  const config = await loadConfig(configPath());
  const store = new Store(config.databasePath);
  try {
    // Positions are Uniswap NFTs on EVM chains; Solana (Raydium) is for pool listings only.
    const requested = parseChains(options.chain);
    const targets = walletTargets(options.wallet, requested, config, store);
    if (!targets.length) throw new Error('No wallets saved. Run defi-tool wallet add 0xYourAddress --chain eth, or pass --wallet 0xYourAddress.');
    const checks = targets.filter((target) => isEvmChain(target.chainId));
    if (!checks.length) throw new Error('Positions are read for Uniswap on EVM chains only, not Solana. Choose an EVM wallet or --chain, e.g. --chain eth.');
    if (checks.length < targets.length) console.error('Note: skipping Solana; positions are read for Uniswap on EVM chains only.');
    const source = dataSource(options, config);
    const ids: string[] | undefined = options.position === undefined ? undefined : options.position.split(',').map((id: string) => id.trim());
    if (ids && (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id) || BigInt(id) >= 2n ** 256n))) throw new Error('--position must contain unsigned NFT IDs, e.g. --position 123,456.');
    if (ids && checks.length !== 1) throw new Error('--position requires one --wallet and one --chain so NFT IDs are unambiguous.');
    if (ids && source === 'custom') throw new Error('--position is for direct RPC reads; add --source public.');
    if (source === 'public' && options.protocol === 'v4' && !ids) throw new Error('Public v4 wallet discovery needs an indexer. Use --position <NFT IDs> with one --wallet and one --chain, without an API key.');
    const api = new UniswapApiClient({ endpoint: options.apiUrl ?? config.apiUrl, apiKey: config.apiKey });
    const rpc = new RpcProvider(config.rpcUrls);
    let failures = 0;
    const analyses: PositionAnalysis[] = [];
    for (const { address: wallet, chainId } of checks) {
      const chain = chainId as EvmChainId;
      try {
        const found = source === 'public' ? await rpc.listPositions(wallet, chain, options.protocol as Protocol, ids) : await api.listPositions(wallet, chain, options.protocol as Protocol);
        for (const position of found) {
          const pool: Pool = { id: position.poolId, chainId: chain, protocol: position.protocol, token0: { address: '', symbol: '?', decimals: 18 }, token1: { address: '', symbol: '?', decimals: 18 }, source: 'uniswap-api', observedAt: new Date().toISOString() };
          analyses.push(analyzePosition(position, position.currentTick ?? await rpc.currentTick(pool), config.saturationThresholdPct));
        }
      } catch (error) {
        failures += 1;
        console.error(`${wallet} on ${CHAINS[chain].name}: ${(error as Error).message}`);
      }
    }
    if (failures === checks.length) throw new Error(source === 'public' ? 'Position RPC reads failed for every wallet/network. Public RPCs may be busy; retry or configure an RPC_URL_* endpoint. No Uniswap API key is needed.' : 'Custom position discovery failed for every wallet/network. Check your provider endpoint and access settings.');
    store.savePositions(analyses);
    if (command === analyze) {
      printPositions(analyses, Boolean(options.json));
    } else {
      const fresh = buildAlerts(analyses, new Map()).filter((alert) => !store.hasAlert(alert.fingerprint));
      fresh.forEach((alert) => store.saveAlert(alert));
      if (options.json) console.log(JSON.stringify({ schemaVersion: 1, data: fresh }, null, 2));
      else {
        fresh.length ? fresh.forEach((alert) => console.log(`[${alert.type}] ${alert.message}`)) : console.log('No new alerts.');
        const unknown = analyses.filter((analysis) => analysis.status === 'unknown').length;
        if (unknown) console.log(`${unknown} position(s) have unknown range status. Run defi-tool positions analyze to inspect missing data.`);
      }
      if (fresh.length) process.exitCode = 2;
    }
  } finally { store.close(); }
});

/**
 * The wallet/network pairs to check. A saved wallet name uses its own network and an address the networks saved by init,
 * unless --chain is given. Without --wallet, every saved wallet and every init wallet is checked. A Solana wallet stays on Solana.
 */
function walletTargets(value: string | undefined, chains: ChainId[] | undefined, config: AppConfig, store: Store): Array<{ address: string; chainId: ChainId }> {
  const targets: Array<{ address: string; chainId: ChainId }> = [];
  const add = (address: string, networks: ChainId[]) => {
    for (const chainId of networks) if (!targets.some((target) => target.address === address && target.chainId === chainId)) targets.push({ address, chainId });
  };
  const addSaved = (wallet: SavedWallet) => add(wallet.address, chains && isEvmChain(wallet.chainId) ? chains : [wallet.chainId]);
  if (value === undefined) {
    store.wallets().forEach(addSaved);
    for (const address of parseWallets(config.wallets.join(','))) add(address, chains ?? config.chains);
    return targets;
  }
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const saved = store.wallet(entry);
    if (saved) addSaved(saved);
    else if (/^0x[0-9a-fA-F]{40}$/.test(entry)) add(entry.toLowerCase(), chains ?? config.chains);
    else throw new Error(`--wallet "${entry}" is neither a saved wallet name nor a 0x address with 40 hexadecimal characters. Run defi-tool wallet list to see saved names.`);
  }
  return targets;
}

/**
 * Addresses and networks for positions list. Saved wallets (--wallet, or all of them by default) are read on their saved
 * network; --wallet-addr addresses on every EVM network. --chain narrows both. Wallets sharing an address are read together.
 */
function walletGroups(names: string | undefined, addresses: string | undefined, chains: ChainId[] | undefined, config: AppConfig, store: Store): WalletGroup[] {
  const groups = new Map<string, WalletGroup>();
  const evmChains = (Object.keys(CHAINS).map(Number) as ChainId[]).filter(isEvmChain);
  const narrow = (networks: ChainId[]) => networks.filter((chain): chain is EvmChainId => isEvmChain(chain) && (!chains || chains.includes(chain)));
  const add = (address: string, networks: EvmChainId[], name?: string) => {
    const group = groups.get(address) ?? { address, chains: [], names: {} };
    for (const chain of networks) {
      if (!group.chains.includes(chain)) group.chains.push(chain);
      if (name) group.names![chain] = name;
    }
    if (group.chains.length) groups.set(address, group);
  };
  const split = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const skipped: string[] = [];
  const addSaved = (saved: SavedWallet) => {
    if (!isEvmChain(saved.chainId)) return skipped.push(`${saved.name} (Solana)`);
    if (!narrow([saved.chainId]).length) return skipped.push(`${saved.name} (${CHAINS[saved.chainId].name}, not in --chain)`);
    add(saved.address, narrow([saved.chainId]), saved.name);
  };
  if (names !== undefined) {
    for (const name of split(names)) {
      const saved = store.wallet(name);
      if (!saved) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets, or use --wallet-addr for an address.`);
      addSaved(saved);
    }
  }
  if (addresses !== undefined) {
    for (const address of split(addresses)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`--wallet-addr "${address}" is not a 0x address with 40 hexadecimal characters. Uniswap positions are on EVM networks; Solana addresses are not supported.`);
      add(address.toLowerCase(), narrow(evmChains));
    }
  }
  if (names === undefined && addresses === undefined) {
    store.wallets().forEach(addSaved);
    for (const address of parseWallets(config.wallets.join(','))) add(address, narrow(config.chains));
  }
  if (skipped.length) console.error(`Note: skipping ${skipped.join(', ')}; Uniswap positions are read on EVM networks${chains ? ' in --chain' : ''}.`);
  return [...groups.values()];
}

/** "ledger (0x902e…3f00) on Ethereum" or "0x902e…3f00 on all networks". */
function groupLabel(group: WalletGroup): string {
  const names = [...new Set(Object.values(group.names ?? {}))];
  const address = `${group.address.slice(0, 6)}…${group.address.slice(-4)}`;
  const evmCount = Object.keys(CHAINS).map(Number).filter((chain) => isEvmChain(chain as ChainId)).length;
  const networks = group.chains.length === evmCount ? 'all networks' : group.chains.map((chain) => CHAINS[chain].name).join(', ');
  return `${names.length ? `${names.join(', ')} (${address})` : address} on ${networks}`;
}

const wallet = app.command('wallet').description('Save, list, rename, and delete the wallets that positions and alerts check.');
commandHelp(wallet, ['defi-tool wallet add 0xYourWallet --chain eth --name main', 'defi-tool wallet list', 'defi-tool wallet edit main --name trading', 'defi-tool wallet delete trading'], [
  'Wallets are saved in the local database by name. Only public addresses are stored; no private key is ever requested.',
  'positions and alerts check every saved wallet on its network, or the ones named in --wallet.',
]);
wallet.action(() => wallet.outputHelp());

const walletAdd = wallet.command('add').description('Save a wallet address for one network.')
  .argument('<address>', 'public wallet address: 0x... on EVM networks, base58 on Solana')
  .requiredOption('--chain <name>', 'the wallet\'s network, e.g. eth, base, bnb, or sol (required)')
  .option('--name <name>', 'name to refer to the wallet by, e.g. my-wallet1 (default: wallet0, wallet1, ...)');
commandHelp(walletAdd, ['defi-tool wallet add 0xYourWallet --chain eth', 'defi-tool wallet add 0xYourWallet --chain base --name my-wallet1', 'defi-tool wallet add YourSolanaAddress --chain sol --name phantom'], [
  'Names use up to 30 letters, digits, ".", "_" or "-" and ignore letter case. An address can be saved once per network.',
  'An EVM address is the same on every EVM network: save it once per network, or pass --chain to positions commands.',
  'Solana wallets are stored for reference; positions and alerts read Uniswap positions on EVM networks only.',
]);
walletAdd.action((address: string, options: { chain: string; name?: string }) => withStore((store) => {
  const chainId = parseWalletChain(options.chain);
  const name = options.name === undefined ? store.nextWalletName() : parseWalletName(options.name);
  const saved = store.addWallet({ name, address: parseWalletAddress(address, chainId), chainId });
  console.log(`Saved ${saved.name}: ${saved.address} on ${CHAINS[saved.chainId].name}.`);
}));

const walletList = wallet.command('list').alias('ls').description('Show saved wallets with their network, address, balance, and dates.')
  .option('--no-balance', 'skip reading balances (no network requests)')
  .option('--json', 'print structured JSON instead of a table');
commandHelp(walletList, ['defi-tool wallet list', 'defi-tool wallet list --no-balance', 'defi-tool wallet list --json'], [
  'Balance is read live: the native coin plus well-known tokens (WETH, USDC, cbBTC, ... on Base and Arbitrum) over RPC, SOL over Solana\'s public RPC, valued at DefiLlama prices.',
  'A wallet whose balance cannot be read shows —; the reason goes to stderr.',
]);
walletList.action((options: { balance: boolean; json?: boolean }) => withStore(async (store, config) => {
  const wallets = store.wallets();
  const balances = options.balance && wallets.length
    ? await walletBalances(wallets, new RpcProvider(config.rpcUrls), { solanaRpcUrl: config.rpcUrls[SOLANA], pricesUrl: process.env.DEFI_TOOL_PRICES_URL })
    : undefined;
  printWallets(wallets, balances, Boolean(options.json));
  if (!options.json && config.wallets.length) console.log(`\nAlso checked: ${config.wallets.length} wallet address(es) saved by init in the configuration file.`);
}));

const walletDelete = wallet.command('delete').alias('rm').description('Delete a saved wallet by name.')
  .argument('<name>', 'saved wallet name, as shown by defi-tool wallet list');
commandHelp(walletDelete, ['defi-tool wallet delete wallet0', 'defi-tool wallet rm my-wallet1'], [
  'Only the saved wallet is removed; positions and alerts already recorded for its address stay in the database.',
]);
walletDelete.action((name: string) => withStore((store) => {
  const saved = store.wallet(name);
  if (!saved || !store.deleteWallet(saved.name)) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets.`);
  console.log(`Deleted ${saved.name} (${saved.address} on ${CHAINS[saved.chainId].name}).`);
}));

const walletEdit = wallet.command('edit').description('Rename a saved wallet or change its network.')
  .argument('<name>', 'saved wallet name, as shown by defi-tool wallet list')
  .option('--name <new-name>', 'new name for the wallet')
  .option('--chain <name>', 'new network for the wallet, e.g. base (must suit the address: EVM or Solana)');
commandHelp(walletEdit, ['defi-tool wallet edit wallet0 --name my-wallet1', 'defi-tool wallet edit my-wallet1 --chain base', 'defi-tool wallet edit my-wallet1 --name base-wallet --chain base'], [
  'To change the address, delete the wallet and add it again.',
]);
walletEdit.action((name: string, options: { name?: string; chain?: string }) => withStore((store) => {
  if (options.name === undefined && options.chain === undefined) throw new Error('Nothing to change: pass --name <new-name>, --chain <network>, or both.');
  const current = store.wallet(name);
  if (!current) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets.`);
  const chainId = options.chain === undefined ? undefined : parseWalletChain(options.chain);
  if (chainId !== undefined) parseWalletAddress(current.address, chainId);
  const saved = store.updateWallet(current.name, { name: options.name === undefined ? undefined : parseWalletName(options.name), chainId });
  console.log(`Updated ${current.name}: now ${saved.name}, ${saved.address} on ${CHAINS[saved.chainId].name}.`);
}));

/** Run a wallet command against the configured database. */
async function withStore(task: (store: Store, config: AppConfig) => void | Promise<void>): Promise<void> {
  const config = await loadConfig(configPath());
  const store = new Store(config.databasePath);
  try { await task(store, config); } finally { store.close(); }
}

/** A wallet belongs to exactly one network. */
function parseWalletChain(value: string): ChainId {
  const chains = parseChains(value)!;
  if (chains.length !== 1) throw new Error('--chain takes one network for a wallet, e.g. --chain eth. Save an EVM address once per network to use it on several.');
  return chains[0]!;
}

/** 0x addresses on EVM networks (stored lowercase), base58 addresses on Solana (case kept). */
function parseWalletAddress(value: string, chainId: ChainId): string {
  const address = value.trim();
  const evm = /^0x[0-9a-fA-F]{40}$/.test(address);
  const solana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (isEvmChain(chainId) && evm) return address.toLowerCase();
  if (!isEvmChain(chainId) && solana) return address;
  const network = CHAINS[chainId].name;
  if (isEvmChain(chainId)) throw new Error(`"${address}" is not a valid ${network} address: use 0x followed by 40 hexadecimal characters.${solana ? ' It looks like a Solana address; use --chain sol.' : ''}`);
  throw new Error(`"${address}" is not a valid Solana address: use the 32-44 character base58 address.${evm ? ' It looks like an EVM address; use an EVM --chain such as eth.' : ''}`);
}

/** Names are short, so they can never be mistaken for an address in --wallet. */
function parseWalletName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(name)) throw new Error(`Wallet name "${value}" is not valid: use 1-30 letters, digits, ".", "_" or "-", starting with a letter or digit, e.g. my-wallet1.`);
  return name;
}

function dataSource(options: { source?: 'public' | 'custom'; apiUrl?: string }, config: AppConfig): 'public' | 'custom' {
  return options.source ?? ((options.apiUrl ?? config.apiUrl) !== DEFAULT_API_URL ? 'custom' : 'public');
}

const help = app.command('help [command...]').description('Show help for any command or subcommand.');
commandHelp(help, ['defi-tool help', 'defi-tool help pools rank', 'defi-tool help positions list'], [
  'Equivalent to adding --help after a command. No data is fetched.',
]);
help.action((names: string[] = []) => {
  let target = app;
  for (const name of names) {
    const child = target.commands.find((command) => command.name() === name || command.aliases().includes(name));
    if (!child) throw new Error(`Unknown command "${name}". Run defi-tool help ${target === app ? '' : target.name()} to see available commands.`);
    target = child;
  }
  target.outputHelp();
});

app.parseAsync().catch((error: unknown) => {
  const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : (error as Error).message;
  console.error(`Error: ${message}`);
  console.error('Add --help after your command for usage and examples.');
  process.exitCode = 1;
});

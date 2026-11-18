#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';
import { loadConfig, parseChoice, parsePoolSorts, parsePoolVersions, parseDexes, parsePositiveInt, DEFAULT_API_URL, DEFAULT_CONFIG_PATH, DEFAULT_DATABASE_PATH } from './config.js';
import { runSetup } from './setup.js';
import { commandHelp } from './help.js';
import { FILTER_COLUMNS, parseFilters, type PoolFilter } from './filters.js';
import { Store } from './storage.js';
import { RpcProvider } from './providers/rpc.js';
import { printCreatePlan, printHistory, formatTickerLine, printDexDownloads, printMarketDownloads, renderTickerScreen, printPoolList, printPools, printPositions, printPositionTables, printWallets, type Signer } from './output.js';
import { CREATE_CHAINS } from './providers/tokens.js';
import { walletBalances } from './providers/balances.js';
import type { PositionSource } from './positions.js';
import { GECKO_TIMEFRAMES, GeckoTerminalClient, type Timeframe } from './providers/geckoterminal.js';
import { MAX_HISTORY_DAYS } from './dex-data.js';
import { parseInterval, TickerFeed, tickerJson, watchTicker } from './dex-ticker.js';
import { openInBrowser, renderShow } from './dex-show.js';
import { buildChartHtml } from './html-chart.js';
import { buildPositionHtml } from './position-html.js';
import { renderPositionDetail, statusLine } from './position-view.js';
import { MARKET_TIMEFRAMES, SAMPLE_PERIODS, type MarketTimeframe, type SamplePeriod } from './market-data.js';
import { CANDLE_FORMATS, FILL_MODES, isoTime, type CandleFormat, type FillMode } from './candle-files.js';
import { ACTIVITY_KINDS, CHAINS, DEXES, SOLANA, POOL_SORTS, POOL_VERSIONS, isEvmChain, type AppConfig, type ChainId, type Dex, type PoolVersion, type SavedWallet } from './types.js';
import { addWallet, deleteWallet, editWallet, setDefaultWallet, shortAddress, EVM_CHAINS } from './services/wallets.js';
import { DEFAULT_TOP, SOURCE_NAMES, searchPools } from './services/pools.js';
import { listPortfolio, positionDetailData } from './services/portfolio.js';
import { checkPositions } from './services/alerts.js';
import { checkChoice, findPool, loadPoolChart, parseFeeTier, poolChartJson, type PoolChartRequest } from './services/pool-chart.js';
import { downloadDex, marketData, type DexDownloadRequest } from './services/downloads.js';
import { buildPlan, loadHistory, type PlanRequest } from './services/activity.js';

const app = new Command().name('defi-tool')
  .description('Find Uniswap, PancakeSwap, Aerodrome, Curve and Raydium pools, check the health of your Uniswap LP positions, and download pool and market price history. All commands are read-only.')
  .version('0.1.0').option('--config <file>', 'use a different configuration file')
  .configureHelp({ showGlobalOptions: true }).showSuggestionAfterError(true)
  .showHelpAfterError('Run defi-tool --help, or add --help after any command for examples.');
const configPath = (): string => app.opts().config ?? process.env.DEFI_TOOL_CONFIG ?? DEFAULT_CONFIG_PATH;
commandHelp(app, ['defi-tool init', 'defi-tool chains', 'defi-tool pools scan --chain eth', 'defi-tool pools get WSOL/USDC', 'defi-tool wallet add 0xYourWallet --chain eth --name main', 'defi-tool positions list --wallet main', 'defi-tool dex-data download WETH/USDC --chain base', 'defi-tool market-data download ETH,BTC/ETH', 'defi-tool dex-ticker WETH/USDC --chain base --watch'], [
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
    const config = await loadConfig(configPath());
    const json = Boolean(options.json);
    const store = new Store(config.databasePath);
    try {
      const result = await searchPools({
        mode: action, pair: action === 'get' ? command.args[0]! : undefined, chain: options.chain, protocol: options.protocol, protocolExplicit: command.getOptionValueSource('protocol') === 'cli',
        dex: options.dex, sort: options.sort, top: options.top, limit: options.limit, minTvl: options.minTvl, token: options.token, filters: options.filter, source: options.source, apiUrl: options.apiUrl, quiet: json,
      }, {
        config, store, report: (message) => console.error(message),
        onStart: ({ source, chains, pair, filters }) => {
          if (json) return;
          console.log(`Source: ${SOURCE_NAMES[source]} · ${chains.map((chain) => CHAINS[chain].name).join(', ')} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
          if (pair) console.log(`Pair: ${pair} (either token order)`);
          if (filters.length) console.log(`Filters: ${filters.map((filter) => filter.text).join(' and ')}`);
        },
      });
      // JSON keeps the established { pool, score, ... } shape; the scan table mirrors the Explore page.
      if (result.listing && !json) printPoolList(result.items.map((item) => item.pool), { json: false, sorts: result.sorts });
      else printPools(result.items, json);
    } finally { store.close(); }
  });
}

const positions = app.command('positions').description('List your Uniswap LP positions (open and closed), analyse one in depth, check their ranges, or plan a new one.');
commandHelp(positions, ['defi-tool positions list', 'defi-tool positions create WETH/USDC --chain base --wallet main --amount 100usd --lower-limit -15% --upper-limit +10%', 'defi-tool positions list --wallet wallet0', 'defi-tool positions list --wallet-addr 0xYourWallet --past', 'defi-tool positions detail 1 --output html', 'defi-tool positions analyze --wallet 0xYourWallet --chain eth'], [
  'list shows open and closed positions with prices, ranges, balances, fees, APR and PnL. detail analyses one in depth, with charts. analyze checks range status only (used by alerts).',
  'create builds the transactions for a new v3 position on Base or Arbitrum for your wallet to sign; it never signs or sends.',
  'Without --wallet they use the default wallet (defi-tool wallet set-default; else the latest added); --wallet all uses every saved wallet. list and detail also take --wallet-addr. ls is an alias for list.',
]);
positions.action(() => positions.outputHelp());
const list = positions.command('list').alias('ls')
  .description('Show open and closed Uniswap positions with price, range, balance, fees earned, APR and PnL, as two tables.')
  .option('--wallet <names>', 'saved wallet name(s), comma-separated, read on every EVM network; or all for every saved wallet (default: the default wallet, see wallet set-default)')
  .option('--wallet-addr <addresses>', 'wallet address(es), comma-separated; read on every network unless --chain is given')
  .option('--chain <names>', 'only these networks, e.g. eth,base (default: every EVM network)')
  .option('--active', 'show only open positions')
  .option('--past', 'show only closed positions')
  .option('--top <count>', 'rows per table, 1-1000 (default: 100)')
  .addOption(choiceOption('--source <provider>', 'auto = Revert Finance, falling back to on-chain reads; revert; rpc = on-chain only (no history)', ['auto', 'revert', 'rpc']).default('auto'))
  .option('--json', 'print structured JSON instead of tables');
commandHelp(list, ['defi-tool positions list', 'defi-tool positions list --wallet my-wallet1', 'defi-tool positions list --wallet all', 'defi-tool positions list --wallet-addr 0xYourWallet', 'defi-tool positions list --wallet-addr 0xYourWallet --chain base --past --top 10', 'defi-tool positions list --active --json'], [
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
    const view = await listPortfolio(options, { config, store, report: (message) => console.error(message), quiet: options.json });
    const both = Boolean(options.active) === Boolean(options.past);
    printPositionTables(view.active, view.past, {
      json: Boolean(options.json), showActive: both || Boolean(options.active), showPast: both || Boolean(options.past), top, scope: view.scope, source: view.sourceLabel,
    });
  } finally { store.close(); }
});

const analyze = dataOptions(positions.command('analyze')
  .description('Check whether price is inside each position\'s liquidity range.')
  .option('--wallet <names|addresses>', 'saved wallet name(s) or address(es), comma-separated, or all (default: the default wallet, see wallet set-default)')
  .option('--position <ids>', 'specific NFT token ID(s), comma-separated; required for public v4 reads'));
commandHelp(analyze, ['defi-tool positions analyze', 'defi-tool positions analyze --wallet my-wallet1', 'defi-tool positions analyze --wallet 0xYourWallet --chain eth,arb', 'defi-tool positions analyze --wallet 0xYourWallet --protocol v4 --chain base --position 123 --json'], [
  'Wallets are checked on --chain, or on the networks saved by init (plus a saved wallet\'s own network). Without --wallet, the default wallet is checked.',
  'Near a boundary means within 10% of the tick range by default; configure saturationThresholdPct to change it.',
  'Public v3 discovery uses RPC, without keys. Public v4 requires --position and one wallet/network.',
  'Public RPC defaults are included; custom RPC_URL_* values are optional. Zero-liquidity NFTs are skipped.',
  'RPC-only reads provide range status and liquidity; USD value, amounts, and earned fees are not computed.',
]);

const create = positions.command('create')
  .description('Plan a new Uniswap v3 position and build its transactions for your wallet to sign. Nothing is signed or sent.')
  .argument('[pair]', 'two tokens joined by /, e.g. WETH/USDC (symbols or addresses; ETH means WETH)')
  .requiredOption('--chain <name>', `network: ${CREATE_CHAINS.map((chain) => CHAINS[chain].slug).join(' or ')}`)
  .option('--wallet <name|address>', 'saved wallet name or 0x address that will sign, pay and receive the position NFT (default: the default wallet, see wallet set-default)')
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
create.action(async (pair: string | undefined, options: PlanRequest & { signer: Signer; json?: boolean }) => {
  const config = await loadConfig(configPath());
  const store = new Store(config.databasePath);
  let plan: Awaited<ReturnType<typeof buildPlan>>;
  try {
    plan = await buildPlan({ ...options, pair }, { config, store, report: (message) => console.error(message), quiet: options.json });
  } finally { store.close(); }
  printCreatePlan(plan, { json: Boolean(options.json), signer: options.signer });
});

const detail = positions.command('detail').alias('show')
  .description('Analyse one position in depth: range, entry and exit, holdings, fees, PnL, impermanent loss, time in range, what-if prices and its transactions, with charts.')
  .argument('<position>', 'NFT ID (#5723933 or 5723933), or a row number of defi-tool positions list (open positions; closed ones with --past or when none are open)')
  .option('--wallet <names>', 'saved wallet name(s) holding the position, comma-separated, or all (default: the default wallet, see wallet set-default)')
  .option('--wallet-addr <addresses>', 'wallet address(es), comma-separated; read on every network unless --chain is given')
  .option('--chain <names>', 'only these networks, e.g. base (needed when the same ID exists on two networks)')
  .option('--past', 'a row number counts closed positions instead of open ones')
  .option('--no-plot', 'leave out the charts (price chart with the range, and value against price)')
  .addOption(choiceOption('--output <view>', 'terminal = report here; html = full report with interactive charts in your browser', ['terminal', 'html']).default('terminal'))
  .addOption(choiceOption('--timeframe <size>', 'candle size for the price chart; auto picks one for how long the position was open', ['auto', '15m', '1h', '4h', '1d']).default('auto'))
  .option('--html-file <path>', 'where to write the HTML report (default: <data-dir>/positions/position-<id>_<chain>.html)')
  .option('--no-open', 'write the HTML report without opening a browser')
  .option('--data-dir <path>', 'candle cache shared with dex-data (read first, missing candles are downloaded into it)', 'dex-data')
  .option('--offline', 'use cached candles only; no GeckoTerminal requests')
  .addOption(choiceOption('--source <provider>', 'auto = Revert Finance, falling back to on-chain reads; revert; rpc = on-chain only (no history)', ['auto', 'revert', 'rpc']).default('auto'))
  .option('--width <columns>', 'terminal width to use (default: the terminal\'s)')
  .option('--height <rows>', 'terminal height to use for the charts (default: the terminal\'s)')
  .option('--no-color', 'plain text without colors')
  .option('--json', 'print the whole analysis as JSON');
commandHelp(detail, [
  'defi-tool positions detail 1',
  "defi-tool positions detail '#5723933' --output html",
  'defi-tool positions detail 2 --past --no-plot',
  'defi-tool positions detail 1 --wallet my-wallet1',
  'defi-tool positions detail 5723933 --wallet-addr 0xYourWallet --chain arb --json',
], [
  'The report: status and a range gauge, a price chart with the range, entry, exit, breakeven and every transaction, the position\'s value against price',
  'next to holding its tokens, then holdings, performance (PnL, fees, impermanent loss, APR, against holding), time in range and volatility,',
  'what-if prices for an open position, and the transaction list. --output html shows the same as an interactive page with tables and charts.',
  'Positions come from Revert Finance (as positions list); candles are GeckoTerminal\'s, cached in --data-dir like dex-data show (180 days at most).',
]);
detail.action(async (reference: string, options: {
  wallet?: string; walletAddr?: string; chain?: string; past?: boolean; plot: boolean; output: 'terminal' | 'html'; timeframe: 'auto' | Timeframe; htmlFile?: string; open: boolean;
  dataDir: string; offline?: boolean; source: PositionSource; width?: string; height?: string; color: boolean; json?: boolean;
}) => {
  const config = await loadConfig(configPath());
  const width = parsePositiveInt(options.width, '--width') ?? Math.max(80, process.stdout.columns ?? 120);
  const height = parsePositiveInt(options.height, '--height') ?? Math.max(30, Math.min(60, (process.stdout.rows ?? 40) - 4));
  const progress = (text: string) => { if (process.stderr.isTTY && !options.json) process.stderr.write(`\r\x1b[2K${text.slice(0, (process.stderr.columns ?? 100) - 1)}`); };
  const store = new Store(config.databasePath);
  let result: Awaited<ReturnType<typeof positionDetailData>>;
  try {
    result = await positionDetailData({ ...options, reference }, { config, store, report: (message) => console.error(message), quiet: options.json, progress });
  } finally { store.close(); }
  const { analysis, candles, timeframe, step, dataNote, position, how } = result;
  if (options.json) {
    console.log(JSON.stringify({ schemaVersion: 1, data: { ...analysis, candles: candles.map((candle) => ({ time: isoTime(candle.timestamp), ...candle })) } }, null, 2));
    return;
  }
  const color = options.color && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  if (!/^#?\d+$/.test(reference) || how.startsWith('row')) console.error(`Showing ${how}.`);
  if (options.output === 'terminal') {
    console.log(renderPositionDetail(analysis, { width, height, color, plot: options.plot, candles, timeframe, dataNote }));
    return;
  }
  const file = options.htmlFile ?? join(options.dataDir, 'positions', `position-${position.id}_${CHAINS[position.chainId].slug}.html`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buildPositionHtml(analysis, { candles, timeframe: timeframe ?? '1h', step, dataNote, plot: options.plot }));
  console.log(`${analysis.pair}${analysis.feeTier === undefined ? '' : ` ${analysis.feeTier / 10_000}%`} #${analysis.id} on ${analysis.chain}: ${statusLine(analysis)}`);
  const launched = options.open && await openInBrowser(resolve(file));
  console.log(`${launched ? 'Opened' : 'Saved'} ${file}${launched ? ' in your browser' : options.open ? ' (no browser could be started; open it yourself)' : ''}.`);
});

const alerts = app.command('alerts').description('Check and persist actionable position alerts.');
commandHelp(alerts, ['defi-tool alerts check', 'defi-tool alerts check --wallet 0xYourWallet --chain eth', 'defi-tool alerts check --help'], [
  'Checks run when you request them; there is no background monitoring process.',
]);
alerts.action(() => alerts.outputHelp());
const check = dataOptions(alerts.command('check')
  .description('Check wallet positions and report new boundary or out-of-range alerts.')
  .option('--wallet <names|addresses>', 'saved wallet name(s) or address(es), comma-separated, or all (default: the default wallet, see wallet set-default)')
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
    const result = await checkPositions(options, command === analyze ? 'analyze' : 'alerts', { config, store, report: (message) => console.error(message), quiet: Boolean(options.json) });
    if (command === analyze) {
      printPositions(result.analyses, Boolean(options.json));
    } else {
      const { fresh, unknown } = result;
      if (options.json) console.log(JSON.stringify({ schemaVersion: 1, data: fresh }, null, 2));
      else {
        fresh.length ? fresh.forEach((alert) => console.log(`[${alert.type}] ${alert.message}`)) : console.log('No new alerts.');
        if (unknown) console.log(`${unknown} position(s) have unknown range status. Run defi-tool positions analyze to inspect missing data.`);
      }
      if (fresh.length) process.exitCode = 2;
    }
  } finally { store.close(); }
});

const wallet = app.command('wallet').description('Save, list, rename, and delete wallets, choose the default one, and show their balances and transaction history.');
commandHelp(wallet, ['defi-tool wallet add 0xYourWallet --chain eth --name main', 'defi-tool wallet list', 'defi-tool wallet set-default main', 'defi-tool wallet history main', 'defi-tool wallet edit main --name trading', 'defi-tool wallet delete trading'], [
  'Wallets are saved in the local database by name. Only public addresses are stored; no private key is ever requested.',
  'Commands that take --wallet use the default wallet without it: the one set with wallet set-default, or else the latest added. --wallet all uses every saved wallet.',
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
  const { wallet: saved, isDefault } = addWallet(store, { address, chain: options.chain, name: options.name });
  const note = isDefault ? ' It is now the default wallet (the latest added, until you choose one with defi-tool wallet set-default).' : '';
  console.log(`Saved ${saved.name}: ${saved.address} on ${CHAINS[saved.chainId].name}.${note}`);
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
  printWallets(wallets, balances, Boolean(options.json), store.defaultWallet());
  if (!options.json && config.wallets.length) console.log(`\nAlso in the configuration file: ${config.wallets.length} wallet address(es) saved by init, read with --wallet all${wallets.length ? '' : ' and while no wallet is saved'}.`);
}));

const walletHistoryCommand = wallet.command('history').alias('tx')
  .description('Show a wallet\'s latest transactions: swaps, liquidity adds and removes, fee collects, transfers, with USD values and gas.')
  .argument('[wallet]', 'saved wallet name, a 0x address, or all for every saved wallet (default: the default wallet, see wallet set-default)')
  .option('--chain <names>', 'networks, e.g. base,arb or all (default: the saved wallet\'s network; every network for an address)')
  .option('--days <count>', 'how far back to look, 1-365 days (default: 30)', '30')
  .option('--type <kinds>', `only these kinds, comma-separated: ${ACTIVITY_KINDS.join(', ')}, or lp (all liquidity kinds)`)
  .option('--top <count>', 'rows to show, 1-500 (default: 50)', '50')
  .option('--all', 'also show likely spam airdrops (unknown, unpriced tokens)')
  .option('--json', 'print structured JSON with full hashes and explorer links');
commandHelp(walletHistoryCommand, ['defi-tool wallet history', 'defi-tool wallet history ledger1', 'defi-tool wallet history all --type lp', 'defi-tool wallet history ledger1 --chain base,arb --days 90', 'defi-tool wallet history ledger1 --type swap --top 20', 'defi-tool wallet history 0xYourWallet --type lp --json'], [
  'Liquidity activity (Uniswap v3/v4 adds, removes and fee collects) comes from Revert Finance, without a key.',
  'Swaps, sends, receives and wraps need a free Alchemy key: export ALCHEMY_API_KEY=... (or alchemyApiKey in the configuration file).',
  'Values are USD at the time of each transaction (DefiLlama). Swap cost = value sent − value received: price impact, pool fees and MEV.',
  'Likely spam airdrops are hidden unless --all. Approvals and transactions that moved no tokens are not listed.',
]);
walletHistoryCommand.action((target: string | undefined, options: { chain?: string; days: string; type?: string; top: string; all?: boolean; json?: boolean }) => withStore(async (store, config) => {
  const { several, days, histories } = await loadHistory({ ...options, target }, { config, store, report: (message) => console.error(message), quiet: options.json });
  // One wallet keeps the usual JSON; "all" prints one entry per wallet.
  if (options.json && several) {
    console.log(JSON.stringify({ schemaVersion: 1, data: histories.map(({ wallets, address, chains, result }) => ({
      wallets, address, chains, total: result.total, spamHidden: result.spamHidden, summary: result.summary, sources: result.sources, activities: result.activities,
    })) }, null, 2));
    return;
  }
  histories.forEach(({ wallets, address, chains, result }, index) => {
    const networks = chains.length === EVM_CHAINS.length ? 'all networks' : chains.map((chain) => CHAINS[chain].name).join(', ');
    if (index) console.log('');
    printHistory(result, { json: Boolean(options.json), title: `Wallet history · ${wallets.length ? `${wallets.join(', ')} (${shortAddress(address)})` : shortAddress(address)} on ${networks}`, days });
  });
}));

const walletSetDefault = wallet.command('set-default').alias('default')
  .description('Choose the wallet commands use when --wallet is not given.')
  .argument('[wallet]', 'saved wallet name, its number in defi-tool wallet list, or its address (with --chain when saved on several networks); omit to show the current default')
  .option('--chain <name>', 'the network, when the address is saved on more than one');
commandHelp(walletSetDefault, ['defi-tool wallet set-default ledger1', 'defi-tool wallet set-default 2', 'defi-tool wallet set-default 0xYourWallet --chain base', 'defi-tool wallet set-default'], [
  'Until one is chosen, the most recently added wallet is the default. Deleting the default falls back to that rule; renaming keeps it.',
  'Used by positions list, detail, analyze and create, alerts check and wallet history when they run without --wallet. --wallet all still reads every saved wallet.',
]);
walletSetDefault.action((target: string | undefined, options: { chain?: string }) => withStore((store) => {
  const describe = (saved: SavedWallet) => `${saved.name} (${saved.address} on ${CHAINS[saved.chainId].name})`;
  if (target === undefined) {
    const current = store.defaultWallet();
    if (!current) throw new Error('No saved wallets. Add one with defi-tool wallet add 0xYourWallet --chain eth.');
    console.log(`Default wallet: ${describe(current.wallet)}${current.chosen ? '' : ', the latest added; choose one with defi-tool wallet set-default <name>'}.`);
    return;
  }
  const saved = setDefaultWallet(store, target, options.chain);
  console.log(`Default wallet: ${describe(saved)}. Commands use it when --wallet is not given.`);
}));

const walletDelete = wallet.command('delete').alias('rm').description('Delete a saved wallet by name.')
  .argument('<name>', 'saved wallet name, as shown by defi-tool wallet list');
commandHelp(walletDelete, ['defi-tool wallet delete wallet0', 'defi-tool wallet rm my-wallet1'], [
  'Only the saved wallet is removed; positions and alerts already recorded for its address stay in the database.',
]);
walletDelete.action((name: string) => withStore((store) => {
  const saved = deleteWallet(store, name);
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
  const { before, after } = editWallet(store, name, options);
  console.log(`Updated ${before.name}: now ${after.name}, ${after.address} on ${CHAINS[after.chainId].name}.`);
}));

/** Run a wallet command against the configured database. */
async function withStore(task: (store: Store, config: AppConfig) => void | Promise<void>): Promise<void> {
  const config = await loadConfig(configPath());
  const store = new Store(config.databasePath);
  try { await task(store, config); } finally { store.close(); }
}

const dexData = app.command('dex-data').description('Download and chart historical price candles (OHLCV) for DEX pools, checked and gap-filled.');
commandHelp(dexData, ['defi-tool dex-data download WETH/USDC --chain base', 'defi-tool dex-data download WETH/USDC,cbBTC/USDC --chain base --timeframe 15m --from 7d --format parquet', 'defi-tool dex-data show WETH/USDC --chain base', 'defi-tool dex-data show WETH/USDC --chain base --output html'], [
  'Candles come from GeckoTerminal\'s public API, without a key. It keeps the last 180 days; show keeps what you downloaded before that too.',
]);
dexData.action(() => dexData.outputHelp());

const download = dexData.command('download')
  .description('Download price candles (open, high, low, close, volume) for one or more pools and save them as files.')
  .argument('[pairs]', 'token pairs, comma-separated, e.g. WETH/USDC,cbBTC/USDC: symbols or addresses, in either order')
  .option('--chain <names>', 'networks to search, e.g. base or eth,arb (default: saved chains); each pair uses its deepest matching pool')
  .addOption(new Option('--dex <names>', `exchanges to consider, comma-separated: ${DEXES.join(', ')}, or all`)
    .argParser((value: string) => { try { return parseDexes(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['uniswap'], 'uniswap'))
  .addOption(new Option('--protocol <versions>', 'pool types to consider, comma-separated: v2, v3, v4, clmm, amm, or all')
    .argParser((value: string) => { try { return parsePoolVersions(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['v3'], 'v3'))
  .option('--fee <percent>', 'fee tier in percent, e.g. 0.05 or 0.3 (default: the deepest pool, any tier)')
  .option('--pool <addresses>', 'pool addresses or v4 pool IDs, comma-separated, instead of pairs (needs a single --chain)')
  .addOption(choiceOption('--timeframe <size>', 'candle size', Object.keys(GECKO_TIMEFRAMES)).default('1h'))
  .option('--from <time>', `start: a duration ago (30d, 12h, 2w), a UTC date (2026-10-01) or date-time (2026-10-01T12:00), or unix seconds; at most ${MAX_HISTORY_DAYS}d`, '30d')
  .option('--to <time>', 'end, in the same forms as --from', 'now')
  .addOption(choiceOption('--format <type>', 'file format: csv, json (metadata included), jsonl (one candle per line), parquet', CANDLE_FORMATS).default('csv'))
  .option('--out-dir <folder>', 'folder for the files (created if needed)', 'dex-data')
  .option('--quote <token>', 'price unit: auto (stablecoin, then native coin), usd, or one of the pair\'s tokens', 'auto')
  .addOption(choiceOption('--fill <mode>', 'periods without trades: forward = previous close, zero volume, marked filled; none = leave them out', FILL_MODES).default('forward'))
  .option('--include-partial', 'keep the newest candle even though its period has not ended')
  .option('--force', 'replace files that already exist')
  .option('--dry-run', 'show which pools would be used and how many requests, without downloading')
  .option('--json', 'print the download summary as JSON');
commandHelp(download, [
  'defi-tool dex-data download WETH/USDC --chain base',
  'defi-tool dex-data download WETH/USDC,cbBTC/USDC --chain base --fee 0.05 --timeframe 15m --from 7d',
  'defi-tool dex-data download ETH/USDC --chain eth,arb --protocol v3,v4 --format parquet --out-dir ./data',
  'defi-tool dex-data download WETH/USDC --chain arb --from 2026-09-01 --to 2026-10-01 --timeframe 1d --quote usd',
  'defi-tool dex-data download SOL/USDC --chain solana --dex raydium --protocol clmm',
  'defi-tool dex-data download --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --dry-run',
], [
  'Candles come from GeckoTerminal\'s public API, without a key. It keeps the last 180 days, and returns up to 1,000 candles per request.',
  'Longer ranges are fetched page by page, with requests spaced about 2 seconds apart (the public limit is about 30 a minute). A rate limit waits and retries.',
  `Timeframes: ${Object.keys(GECKO_TIMEFRAMES).join(', ')}. Times are UTC; each candle's time is the start of its period. Only finished periods are kept unless --include-partial.`,
  'Each file is checked: malformed rows, misaligned times and impossible prices (high below open or close, zero prices) are dropped; overlapping pages are merged.',
  'GeckoTerminal sends no candle for a period without trades. --fill forward (default) adds one at the previous close with zero volume and filled=true, since the pool price cannot move without a trade.',
  'Prices are in the more money-like token (USDC per WETH) unless --quote says otherwise; volume is in the same unit. A .meta.json file beside each file records the pool, units and checks.',
  'Without --fee, each pair uses the deepest pool matching --dex and --protocol; the summary names the next ones.',
]);
download.action(async (pairsArg: string | undefined, options: Omit<DexDownloadRequest, 'pairs'> & { json?: boolean }) => {
  const progress = (text: string) => { if (process.stderr.isTTY && !options.json) process.stderr.write(`\r\x1b[2K${text}`); };
  const config = await loadConfig(configPath());
  const { results, range } = await downloadDex({ ...options, pairs: pairsArg }, { config, report: (message) => console.error(message), progress });
  printDexDownloads(results, { json: Boolean(options.json), dryRun: Boolean(options.dryRun), timeframe: options.timeframe, from: range.start, to: range.end });
  if (results.every((result) => result.error)) process.exitCode = 1;
});

const show = dexData.command('show')
  .description('Chart a DEX pool\'s candles with its live ticker, in the terminal or as an interactive HTML page, from the download cache first.')
  .argument('[pair]', 'two tokens joined by /, e.g. WETH/USDC: symbols or addresses, in either order')
  .option('--chain <names>', 'networks to search, e.g. base or eth,arb (default: saved chains); the deepest matching pool is used')
  .addOption(new Option('--dex <names>', `exchanges to consider, comma-separated: ${DEXES.join(', ')}, or all`)
    .argParser((value: string) => { try { return parseDexes(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['uniswap'], 'uniswap'))
  .addOption(new Option('--protocol <versions>', 'pool types to consider, comma-separated: v2, v3, v4, clmm, amm, or all')
    .argParser((value: string) => { try { return parsePoolVersions(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['v3'], 'v3'))
  .option('--fee <percent>', 'fee tier in percent, e.g. 0.05 or 0.3 (default: the deepest pool, any tier)')
  .option('--pool <address>', 'a pool address or v4 pool ID instead of a pair (needs a single --chain)')
  .option('--quote <token>', 'price unit: auto (stablecoin, then native coin), usd, or one of the pair\'s tokens', 'auto')
  .addOption(choiceOption('--timeframe <size>', 'candle size', Object.keys(GECKO_TIMEFRAMES)).default('1h'))
  .option('--from <time>', 'start: a duration ago (30d, 12h, 2w), a UTC date or date-time, or unix seconds (default: all time: the cache plus GeckoTerminal\'s 180 days)')
  .option('--to <time>', 'end, in the same forms as --from', 'now')
  .addOption(choiceOption('--output <view>', 'terminal = candlestick chart here; html = interactive page in your browser', ['terminal', 'html']).default('terminal'))
  .option('--html-file <path>', 'where to save the HTML page (default: <data-dir>/charts/<pair>_<chain>_<timeframe>.html)')
  .option('--no-open', 'with --output html, save the page without opening a browser')
  .option('--data-dir <folder>', 'the download cache: where dex-data download saves files, and where new downloads go', 'dex-data')
  .option('--offline', 'use only the cache: no pool search, downloads or live ticker')
  .option('--refresh', 'download the available range again instead of using cached candles')
  .option('--width <columns>', 'terminal chart width (default: the terminal\'s)')
  .option('--height <rows>', 'terminal chart height, volume included (default: the terminal\'s)')
  .option('--no-volume', 'leave out the volume bars in the terminal chart')
  .option('--no-color', 'plain text without colors (NO_COLOR also works)')
  .option('--json', 'print the candles, figures and live ticker as JSON instead of a chart');
commandHelp(show, [
  'defi-tool dex-data show WETH/USDC --chain base',
  'defi-tool dex-data show WETH/USDC --chain base --fee 0.05 --timeframe 15m --from 3d',
  'defi-tool dex-data show WETH/USDC --chain base --output html',
  'defi-tool dex-data show cbBTC/USDC --chain base --timeframe 1d --output html --html-file ./cbbtc.html --no-open',
  'defi-tool dex-data show WETH/USDC --chain base --offline',
  'defi-tool dex-data show --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --timeframe 4h --json',
], [
  'Data comes from the download cache first (--data-dir, the files dex-data download saves). Finer cached candles are combined into the --timeframe (15m files make a 1h chart).',
  'Missing stretches within GeckoTerminal\'s 180 days are downloaded and saved to the cache, so the next show is instant and older data stays after GeckoTerminal drops it.',
  'Without --from, it shows all time: everything cached plus GeckoTerminal\'s 180 days. The live ticker (price, 24h change, high, low, volume, liquidity) is shown above the chart and marked on it.',
  'The terminal chart fits your terminal: long ranges merge candles per column (the header says how many). Green candles rose, red fell, grey had no trades.',
  'The HTML page is one self-contained file (the chart library is inside it), so it works offline: zoom, pan, hover for OHLC and volume, switch timeframes and themes.',
  'Pool choice works as in dex-data download. --offline finds the pool among cached files instead of searching.',
]);
show.action(async (pairArg: string | undefined, options: Omit<PoolChartRequest, 'pair'> & {
  output: 'terminal' | 'html'; htmlFile?: string; open: boolean; width?: string; height?: string; volume: boolean; color: boolean; json?: boolean;
}) => {
  checkChoice({ ...options, pair: pairArg }, 'dex-data show');
  if (options.offline && options.refresh) throw new Error('--refresh downloads again, so it cannot be combined with --offline.');
  const config = await loadConfig(configPath());
  parseFeeTier(options.fee);
  const width = parsePositiveInt(options.width, '--width') ?? Math.max(60, process.stdout.columns ?? 100);
  const height = parsePositiveInt(options.height, '--height') ?? Math.max(20, Math.min(60, (process.stdout.rows ?? 32) - 4));
  const progress = (text: string) => { if (process.stderr.isTTY && !options.json) process.stderr.write(`\r\x1b[2K${text.slice(0, (process.stderr.columns ?? 100) - 1)}`); };
  const chart = await loadPoolChart({ ...options, pair: pairArg }, { config, report: (message) => console.error(message), progress });
  const { view, meta, ticker, tickerNote } = chart;
  if (options.json) {
    console.log(JSON.stringify(poolChartJson(chart), null, 2));
    return;
  }
  const color = options.color && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  if (options.output === 'terminal') {
    console.log(renderShow(view, { width, height, volume: options.volume, color }));
    return;
  }
  const file = options.htmlFile ?? join(options.dataDir, 'charts', `${view.pair.replace('/', '-').replace(/[^A-Za-z0-9.-]+/g, '')}_${CHAINS[meta.chainId].slug}_${meta.address.slice(0, 8)}_${options.timeframe}.html`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buildChartHtml(view));
  console.log(ticker ? formatTickerLine(ticker, color) : `${view.pair}: live price unavailable (${tickerNote}).`);
  const opened = options.open && await openInBrowser(resolve(file));
  console.log(`${opened ? 'Opened' : 'Saved'} ${file}${opened ? ' in your browser' : options.open ? ' (no browser could be started; open it yourself)' : ''}.`);
});

const market = app.command('market-data').description('Download historical market prices (blended across all venues) for coins and pairs, as candles.');
commandHelp(market, ['defi-tool market-data download ETH', 'defi-tool market-data download BTC/ETH,SOL --timeframe 1d --from 365d --format parquet'], [
  'Prices are DefiLlama\'s blended USD price per coin, without a key. For pool prices on one exchange, use dex-data.',
]);
market.action(() => market.outputHelp());

const marketDownload = market.command('download')
  .description('Download market price candles (open, high, low, close) for coins or pairs and save them as files.')
  .argument('<pairs>', 'coins or pairs, comma-separated: ETH (in USD), BTC/ETH (cross rate), coingecko:<id>, or chain:address such as base:0x…')
  .addOption(choiceOption('--timeframe <size>', 'candle size', Object.keys(MARKET_TIMEFRAMES)).default('1h'))
  .addOption(choiceOption('--sample <period>', 'spacing of the price samples candles are built from (auto: about 12 per candle, at least 5m)', ['auto', ...Object.keys(SAMPLE_PERIODS)]).default('auto'))
  .option('--from <time>', 'start: a duration ago (30d, 12h, 2w), a UTC date (2026-10-01) or date-time (2026-10-01T12:00), or unix seconds', '30d')
  .option('--to <time>', 'end, in the same forms as --from', 'now')
  .addOption(choiceOption('--format <type>', 'file format: csv, json (metadata included), jsonl (one candle per line), parquet', CANDLE_FORMATS).default('csv'))
  .option('--out-dir <folder>', 'folder for the files (created if needed)', 'market-data')
  .addOption(choiceOption('--fill <mode>', 'periods without samples: forward = previous close, marked filled; none = leave them out', FILL_MODES).default('forward'))
  .option('--include-partial', 'keep the newest candle even though its period has not ended')
  .option('--force', 'replace files that already exist')
  .option('--dry-run', 'show the coins found and how many requests, without downloading')
  .option('--json', 'print the download summary as JSON');
commandHelp(marketDownload, [
  'defi-tool market-data download ETH',
  'defi-tool market-data download ETH,BTC,SOL --timeframe 15m --from 7d',
  'defi-tool market-data download BTC/ETH,ETH/USDT --timeframe 1d --from 2025-01-01 --format parquet',
  'defi-tool market-data download coingecko:aerodrome-finance --timeframe 4h --from 90d',
  'defi-tool market-data download base:0x940181a94a35a4569e4529a3cdfb74e38fd98631/ETH --dry-run',
], [
  'Prices are DefiLlama\'s blended USD price per coin across markets, without a key; DefiLlama keeps a sample about every 5 minutes, for roughly the last 800 days.',
  'A single coin is priced in USD. A pair is a cross rate: the first coin\'s USD price divided by the second\'s at the same moment, so ETH/USDT shows a USDT depeg.',
  'Symbols are looked up on CoinGecko; the coin with that symbol and the best market-cap rank wins, and the summary shows which. Use coingecko:<id> or chain:address to pick another.',
  'Candles are built from samples: open = first, close = last, high/low = highest/lowest sample. Highs and lows between samples are missed; the samples column says how many were used. There is no volume.',
  'Each file is checked: malformed or zero prices and duplicate samples are dropped, periods without samples are filled forward (filled=true) unless --fill none, and >50% jumps, thin candles and DefiLlama\'s confidence are reported.',
  `Timeframes: ${Object.keys(MARKET_TIMEFRAMES).join(', ')}. Times are UTC; weeks start on Monday. Each request fetches up to 500 samples (250 per coin for a pair).`,
]);
marketDownload.action(async (pairsArg: string, options: {
  timeframe: MarketTimeframe; sample: SamplePeriod | 'auto'; from: string; to: string; format: CandleFormat; outDir: string; fill: FillMode;
  includePartial?: boolean; force?: boolean; dryRun?: boolean; json?: boolean;
}) => {
  const progress = (text: string) => { if (process.stderr.isTTY && !options.json) process.stderr.write(`\r\x1b[2K${text}`); };
  const { results, range } = await marketData({ ...options, pairs: pairsArg, write: { format: options.format, outDir: options.outDir, force: options.force } }, { progress });
  printMarketDownloads(results, { json: Boolean(options.json), dryRun: Boolean(options.dryRun), timeframe: options.timeframe, from: range.start, to: range.end });
  if (results.every((result) => result.error)) process.exitCode = 1;
});

const dexTicker = app.command('dex-ticker')
  .description('Show a DEX pool\'s ticker: price, 24h change, high, low, volume and liquidity. Add --watch for a live view.')
  .argument('[pair]', 'two tokens joined by /, e.g. WETH/USDC: symbols or addresses, in either order')
  .option('--chain <names>', 'networks to search, e.g. base or eth,arb (default: saved chains); the deepest matching pool is used')
  .addOption(new Option('--dex <names>', `exchanges to consider, comma-separated: ${DEXES.join(', ')}, or all`)
    .argParser((value: string) => { try { return parseDexes(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['uniswap'], 'uniswap'))
  .addOption(new Option('--protocol <versions>', 'pool types to consider, comma-separated: v2, v3, v4, clmm, amm, or all')
    .argParser((value: string) => { try { return parsePoolVersions(value); } catch (error) { throw new InvalidArgumentError((error as Error).message); } })
    .default(['v3'], 'v3'))
  .option('--fee <percent>', 'fee tier in percent, e.g. 0.05 or 0.3 (default: the deepest pool, any tier)')
  .option('--pool <address>', 'a pool address or v4 pool ID instead of a pair (needs a single --chain)')
  .option('--quote <token>', 'price unit: auto (stablecoin, then native coin), usd, or one of the pair\'s tokens', 'auto')
  .option('--watch', 'keep the ticker on screen and update it live; q or Ctrl+C quits')
  .option('--interval <duration>', 'time between updates with --watch, at least 5s (e.g. 10s, 1m)', '10s')
  .option('--count <n>', 'with --watch, stop after this many updates')
  .option('--no-color', 'plain text without colors (NO_COLOR also works)')
  .option('--json', 'print JSON: one object, or one per line with --watch');
commandHelp(dexTicker, [
  'defi-tool dex-ticker WETH/USDC --chain base',
  'defi-tool dex-ticker WETH/USDC --chain base --fee 0.05 --watch',
  'defi-tool dex-ticker cbBTC/USDC --chain base --watch --interval 30s',
  'defi-tool dex-ticker SOL/USDC --chain solana --dex raydium --protocol clmm --quote usd',
  'defi-tool dex-ticker --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --json',
  'defi-tool dex-ticker WETH/USDC --chain arb --watch --json --count 6 > ticks.jsonl',
], [
  'Data comes from GeckoTerminal\'s public API, without a key. Its pool prices refresh about every 10-60 seconds, so updates faster than that repeat the same price.',
  'Price is the pool\'s own price, in the more money-like token (USDC per WETH) unless --quote says otherwise. 24h change, high and low come from the pool\'s 15-minute candles in the same unit, refreshed every minute; volume and liquidity are in USD.',
  'Without --watch, it prints one line and exits. With --watch in a terminal, it takes over the screen and redraws in place; piped or redirected, it prints a line per update instead.',
  'Each update uses one request (two when the 24h figures refresh). GeckoTerminal allows about 30 a minute, so --interval is at least 5s; failed updates keep the last figures and retry with growing waits.',
  'Pool choice works as in dex-data: the deepest pool matching --dex, --protocol and --fee on the --chain networks.',
]);
dexTicker.action(async (pairArg: string | undefined, options: {
  chain?: string; dex: Dex[]; protocol: PoolVersion[]; fee?: string; pool?: string; quote: string; watch?: boolean; interval: string; count?: string; color: boolean; json?: boolean;
}) => {
  if (pairArg && options.pool) throw new Error('Give either a pair or --pool, not both.');
  if (!pairArg && !options.pool) throw new Error('Name a pair, e.g. defi-tool dex-ticker WETH/USDC --chain base, or use --pool.');
  if (!options.watch && (options.count !== undefined || dexTicker.getOptionValueSource('interval') === 'cli')) throw new Error('--interval and --count only apply with --watch.');
  const intervalMs = parseInterval(options.interval);
  const count = parsePositiveInt(options.count, '--count');
  const config = await loadConfig(configPath());
  parseFeeTier(options.fee);
  const client = new GeckoTerminalClient({ endpoint: process.env.DEFI_TOOL_GECKOTERMINAL_URL });
  const pool = await findPool(client, { ...options, pair: pairArg }, config, {
    onError: (chain, error) => console.error(`${pairArg} on ${CHAINS[chain].name}: ${error.message}`),
  });
  const feed = new TickerFeed(client, pool, options.quote);
  const color = options.color && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  if (!options.watch) {
    const ticker = await feed.read();
    console.log(options.json ? JSON.stringify(tickerJson(ticker), null, 2) : formatTickerLine(ticker, color));
    return;
  }
  const updates = await watchTicker(feed, { intervalMs, count, json: Boolean(options.json), color }, {
    write: (text) => process.stdout.write(text), error: (text) => process.stderr.write(text), tty: Boolean(process.stdout.isTTY),
    input: process.stdin, render: renderTickerScreen, line: formatTickerLine,
  });
  if (!updates) process.exitCode = 1;
});

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


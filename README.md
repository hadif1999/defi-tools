# defi-tool

A read-only DeFi CLI: pool discovery and ranking for Uniswap, PancakeSwap, Aerodrome and Curve (EVM chains) and Raydium (Solana), plus Uniswap LP position analysis and on-demand alerts.

**No Uniswap API key is needed.** Pool listings use DefiLlama's public yields API (GeckoTerminal is available as an alternative); position checks and alerts use public chain RPCs. A custom provider is optional.

## Install once

Use Node.js **22.13+** (Node.js 24 recommended). From this project folder:

```bash
bash scripts/install.sh
defi-tool pools scan --chain eth
```

`init` is optional: run `defi-tool init` if you want to save wallets, preferred chains, or custom RPC URLs.

The installer installs dependencies if missing, builds the CLI, and links `defi-tool` into `~/.local/bin`. No sudo or repeated `npx` invocation is needed. Keep this project folder in place; the installed command points to it. Rerun the installer after updating source code. If the directory is absent from `PATH`, the installer prints the line to add to `~/.zshrc` or your shell's startup file.

Choose another destination with `bash scripts/install.sh --bin-dir /your/bin`. The installer refuses to overwrite an unrelated program. To uninstall, remove only the symlink it created; your configuration and database remain.

## Help at every level

```bash
defi-tool
defi-tool chains
defi-tool pools --help
defi-tool pools rank --help
defi-tool positions list --help
defi-tool alerts check --help
defi-tool init --help
```

Root and command groups show help when invoked without a subcommand. Each command's help includes examples, defaults, and relevant cautions.

## Explore pools

`pools scan` mirrors the [Uniswap Explore pools page](https://app.uniswap.org/explore/pools): v2, v3, and v4 pools on each network, sorted by TVL by default.

```text
$ defi-tool pools scan --chain eth --top 3
Source: DefiLlama public data (no API key) · Ethereum · 2026-10-28 20:35 UTC
Uniswap pools sorted by TVL, highest first

#  Pool        Version     Fee      TVL   1D vol   7D vol  1D vol/TVL     APR
─  ──────────  ───────  ──────  ───────  ───────  ───────  ──────────  ──────
1  WISE/WETH   v2         0.3%  $134.4M  $494.12   $28.0K       <0.01  <0.01%
2  PYUSD/USDS  v4       <0.01%  $100.1M   $19.8M  $216.7M        0.20   0.04%
3  WETH/USDT   v3         0.3%   $88.9M   $27.0M  $160.0M        0.30  33.21%
```

```bash
defi-tool pools scan --chain base --protocol v4 --sort volume --top 10
defi-tool pools scan --chain eth,arb --token USDC --min-tvl 1m
defi-tool pools scan --chain eth --sort apr --min-tvl 100k
defi-tool pools scan --chain eth,base --filter "apr>10" --filter "vol/tvl>1"
defi-tool pools scan --chain base --filter "age<2m" --filter "tvl>100k"
```

- `--sort tvl|volume|apr|vol-tvl` orders highest first. Give several keys to break ties, e.g. `--sort volume,tvl`: later keys only matter when earlier values are equal (or missing, which sorts last). `--protocol` takes one or more pool types, e.g. `v3,v2`, or `all` (default): `v2`, `v3`, `v4` (Uniswap, PancakeSwap), `clmm` (concentrated: Raydium CLMM, Aerodrome Slipstream), `amm` (standard: Raydium AMM, Aerodrome basic, Curve). `--dex` takes one or more of `uniswap`, `pancakeswap` (or `pancake`), `aerodrome`, `curve`, `raydium`, or `all` (default).
- `--token` matches a symbol or address; `ETH` and `WETH` match each other, as in the Uniswap app. `--min-tvl` accepts `50000`, `250k`, or `1m`. Filters apply before `--top`.
- `--filter "<column><op><value>"` keeps rows matching a condition, e.g. `--filter "apr>10"` or `--filter "vol/tvl>=1"`. Repeat the flag or join conditions with commas or `and`; all must hold. Columns: `tvl`, `volume` (1D), `volume-7d`, `vol/tvl`, `apr`, `fee`, `age`; operators `> >= < <= = !=`. Values use the table's units: APR and fee in percent (`apr>10` means 10%), USD amounts accept `250k`, `1m`, `$2,000,000`. Column names ignore case, spaces, and an optional `col.` prefix. Rows without a value for that column are excluded. Quote the condition so the shell does not treat `>` as a redirect.
- `--top` (default 25, max 200) limits the **final** list: `--chain eth,arb --top 10` shows ten pools in total, not ten per chain.
- Option values ignore letter case: `--chain ETH`, `--sort TVL,Apr`, `--protocol V3`, and `--source Public` all work.
- Every row shows its Chain and DEX. With several chains, results are merged in the same order. `defi-tool chains` shows which DEXes each network has: Uniswap everywhere; PancakeSwap on Ethereum, BNB Chain, Base and Arbitrum (v2 at 0.25%, v3); Aerodrome on Base; Curve on Ethereum, Optimism, Polygon, Base and Arbitrum; Raydium on Solana. GeckoTerminal and custom sources list Uniswap only.
- Curve pools can hold three or more tokens (`DAI/USDC/USDT`); `--token` and `pools get` match any of them. Curve and Aerodrome basic pools have no fee tier in the source (Fee shows `—`). Aerodrome pays LPs in AERO rewards rather than trading fees, so many Aerodrome pools have no fee APR (`—`) and fail `--filter "apr>…"`.
- **APR** is the last 24h of trading fees annualized against TVL, *before* Uniswap's protocol fee. The Uniswap app shows the LP share after that fee, so its APR can be lower for the same pool.
- **7D vol** stands in for the app's 30D vol, which the free source does not provide. `<0.01%` marks v4 fee tiers the source rounds to zero; `dynamic` marks hook-set fees. `—` means no data.
- **1D txns** (swaps in the last 24h) and **Age** (time since the pool was created: `6h`, `18d`, `11mo`, `4.5y`) come from the [DexScreener API](https://docs.dexscreener.com/api/reference) (free, no key) for the rows shown. Uniswap v2/v3 pool addresses are derived from the token addresses and fee tier exactly as Uniswap's factories do; PancakeSwap, Aerodrome, Curve and Raydium pools are matched on DexScreener by exchange, tokens and TVL (within 10%), trying the second token's pool list when the first has no match; Curve pools of three or more tokens are not matched. DefiLlama gives no v4 pool ID, so v4 rows try the ID of a hookless pool with standard tick spacing, then DexScreener's pools for the token pair; a match is used only when TVL agrees within 10%, and each DexScreener pool is assigned to at most one row. Unmatched rows (often hooked or unusual-fee v4 pools) show `—`. Pool addresses and creation times never change, so they are cached in the local SQLite database (`pool_identities` table): later runs skip v4 matching and only fetch the live 1D txns, and ages still show when DexScreener is unreachable (1D txns are then empty and a note goes to stderr; the command still succeeds). A v4 pool that could not be matched is retried after 24 hours. Delete the database to clear the cache. JSON adds `address`, `createdAt`, and `txCount24h` when known. `--filter "age>2m"` filters by pool age: units `h`, `d`, `w`, `m`/`mo` (months; for TVL and volume `m` still means million), `y`; a bare number is days. Pools with unknown age are excluded. Because age comes from DexScreener, candidates are checked in sorted order, 60 at a time, until `--top` pools match or 600 have been checked (a note on stderr says so; narrow other filters to reach further). Cached ages make repeat runs fast; if DexScreener is down, the filter uses cached ages only and says so. Age and txns cannot be used in `--sort` yet.
- `pools get <pair>` lists the pools for one token pair on every network and DEX the source covers (Uniswap, PancakeSwap, Aerodrome, Curve, Raydium), e.g. `defi-tool pools get WSOL/USDC` or `defi-tool pools get USDC/USDT --dex curve,pancakeswap`. Tokens are symbols or addresses joined by `/`, matched in either order (`USDC/WSOL` finds `WSOL/USDC` pools); `ETH` also matches `WETH` and `SOL` also matches `WSOL`. Without `--chain` (or with `--chain all`) it searches every network the source lists and silently skips the rest, such as Robinhood Chain on DefiLlama. It takes every `pools scan` option: `defi-tool pools get WSOL/USDC --chain all --protocol v3,v4,clmm,amm --top 50 --sort tvl,apr --filter "apr>30" --filter "vol/tvl>0.4" --filter "tvl>1m" --filter "age>6m"`.
- `pools rank` scores every matching pool with an explainable heuristic and shows the `--top` highest, with confidence. With `--source geckoterminal`, only the first `--top` pools per version and chain are fetched and scored.

```bash
defi-tool pools rank --chain eth,arb --top 10
```

## Your positions

`positions list` shows your Uniswap v3 and v4 LP positions as two tables: **open** positions (still providing liquidity) and **closed** ones (all liquidity withdrawn).

```bash
defi-tool positions list                                   # every saved wallet, each on its saved network
defi-tool positions list --wallet my-wallet1               # saved wallet(s) by name; the network comes from the wallet
defi-tool positions list --wallet-addr 0xYourWallet        # any address, on every network
defi-tool positions list --wallet-addr 0xYourWallet --chain base,arb --past --top 10
defi-tool positions list --active --json
```

```text
Uniswap positions · 0x902e…3f00 on all networks
Source: Revert Finance (no API key) · 2026-10-29 08:22 UTC
Open: 0 (value $0.00, unclaimed fees $0.00) · Closed: 4 · Lifetime fees $5.19 · PnL -$17.66

Open positions (0)
  No open positions.

Closed positions (4) · most recently closed first
#  Chain     Pool                      ID  Range (min – max)    Exit price  Price now  Unit           Deposited  Withdrawn  Fees earned    Gas  Fee APR              PnL       IL  Opened      Closed      Held
─  ────────  ──────────────────  ────────  ───────────────────  ──────────  ─────────  ─────────────  ─────────  ─────────  ───────────  ─────  ───────  ───────────────  ───────  ──────────  ──────────  ────
1  Arbitrum  WETH/USDC 0.05% v3  #5723933  2,354.34 – 2,570.90    2,305.85   2,316.90  USDC per WETH     $78.36     $74.54        $2.81  $0.05   63.71%   -$1.06 (-1.4%)   -$3.82  2026-10-08  2026-10-29   20d
2  Base      WETH/USDC 0.3% v3   #6285249  2,330.91 – 2,596.73    2,312.36   2,313.59  USDC per WETH     $96.25     $91.98        $2.07  $0.02   57.99%   -$2.21 (-2.3%)   -$4.26  2026-10-15  2026-10-29   13d
3  Base      XDP/USDC 0.01% v3   #6236772  0.02200 – 0.03271       0.02167    0.01892  USDC per XDP      $71.36     $61.26        $0.19  $0.02   94.66%  -$9.93 (-13.9%)  -$10.10  2026-10-11  2026-10-12   25h
4  Ethereum  AAVE/WETH 0.3% v3   #1373723  0.05131 – 0.06406       0.05655    0.05635  WETH per AAVE    $100.03     $97.95        $0.11  $2.50   24.15%   -$4.47 (-4.5%)   -$2.08  2026-09-26  2026-09-28   40h
```

- **Open table:** current price, range (min – max), status (`● In range`, `▼ Below x%`, `▲ Above x%`), token balance, value, unclaimed fees, fees earned, fee APR, PnL and age, largest value first.
- **Closed table:** range, exit price (pool price at the last withdrawal), price now, deposited, withdrawn, fees earned, gas, fee APR, PnL, impermanent loss (IL), opened and closed dates and time held, most recently closed first.
- **Prices** use a stablecoin, then the wrapped native coin, as the quote when the pair has one (`USDC per WETH`, `WETH per AAVE`); the Unit column says which.
- **Figures:** deposits, withdrawals, fees and gas are valued in USD at the time each happened. PnL = value now + withdrawals + fees − deposits − gas. Fee APR = fees earned ÷ deposits, annualized over the time held. IL compares the position with holding the deposited tokens.
- **Options:** `--active` or `--past` shows one table (both by default). `--top` limits each table (default 100, up to 1000). `--chain` narrows the networks. `--wallet` takes saved names (see [Wallets](#wallets)), each read only on its saved network; `--wallet-addr` takes addresses, read on every network. Without either, every saved wallet is read, plus addresses saved by `init`. Solana wallets are skipped with a note. `--json` prints `{ "data": { "active": [...], "past": [...] } }`.
- **Data source:** [Revert Finance](https://revert.finance)'s public positions API, without a key: one request per address finds open and closed positions on every network, with their full history. Uniswap's own APIs do not list positions (the Trading API key is not used), and free public RPCs cannot search an address's history on L2s. Revert is a third-party service: its data can lag by a few minutes.
- **Fallback:** if Revert cannot be reached (or with `--source rpc`), the position NFTs the wallet still holds are read over public RPC, with USD prices from DefiLlama: price, range, status, balance and unclaimed fees are shown, but deposits, fees collected, PnL and dates are not, and burned NFTs are missed. Columns without any value are left out. `--source revert` fails instead of falling back. On-chain reads cover v3; v4 NFTs cannot be enumerated without an indexer.
- Results are saved for `wallet list` (positions count and last checked time). No private key is ever requested.

`positions analyze` keeps the earlier range check over RPC, which `alerts check` also uses:

```bash
defi-tool positions analyze --wallet 0xYourWallet --chain eth
defi-tool alerts check --wallet 0xYourWallet --chain eth

# v4 needs the NFT ID(s) from your position, and a single wallet/network
defi-tool positions analyze --wallet 0xYourWallet --chain base --protocol v4 --position 123
```

The examples use a placeholder wallet; replace it with a real address. V3 discovers NFTs held by the wallet. V4's manager does not expose wallet enumeration, so key-free v4 reads require `--position 123,456`. Staked NFTs owned by another contract are not discovered as wallet-held positions. Zero-liquidity NFTs are skipped by `analyze`. Neither path requests a private key or signs transactions.

`--chain` accepts case-insensitive names: `eth`/`ethereum`, `arb`/`arbitrum`, `op`/`optimism`, `polygon`/`matic`/`pol`, `base`, `bnb`/`bsc`/`binance`, `robinhood`/`robinhood-chain`/`rh`, `solana`/`sol`, or `all`. Any start of a name with 3 or more letters also works, in any case: `sol`, `SOLA`, `Solana`, `arbit`, `robin`. `all` can appear in a list (`all,solana` means all), and so can `--protocol all` (`all,v2` means all). Existing numeric IDs still work (BNB Chain is 56, Robinhood Chain 4663; Solana uses the placeholder 501). Without `--chain`, commands use your saved networks, which default to the original five (eth, arb, op, base, polygon); add `bnb`, `robinhood` or `solana` explicitly or use `all`.

**Robinhood Chain:** DefiLlama does not list Uniswap pools there, so pool commands need `--source geckoterminal` (the default source says so and exits). GeckoTerminal cannot sort by TVL, so the CLI fetches up to `--top` pools per version in GeckoTerminal's order (most transactions first) and sorts those; very large but inactive pools can be missed. GeckoTerminal has no 7D volume, and new tokens can show extreme APRs, so `--filter "tvl>100k"` helps. **BNB Chain** uses the default DefiLlama source (v3 and v4). Positions and alerts work on both chains through the official Uniswap v3/v4 contracts. `--top` sets the total number of pools shown (default 25, up to 200); `--limit` remains an alias. Public sources cover indexed pools, not every pool ever created.

**Solana (Raydium):** `--chain solana` lists Raydium pools from the default DefiLlama source, with the DEX column showing Raydium and the Version column `CLMM` (concentrated) or `AMM` (standard); filter them with `--protocol clmm` or `--protocol amm`. Age and 1D txns come from DexScreener, matched by tokens, pool type and TVL. `--token SOL` also matches WSOL. Solana is for `pools scan` and `pools rank` only: positions and alerts read Uniswap NFTs on EVM chains, so they skip Solana (and refuse it when it is the only chain), and `--source geckoterminal`/`custom` do not list it. Raydium's largest pools by TVL include tokens with little trading, so `--sort volume` or `--filter "vol/tvl>0.05"` gives a more useful list.

## Wallets

Save wallets once by name, then refer to them in `positions` and `alerts`:

```bash
defi-tool wallet add 0xYourWallet --chain eth                 # saved as wallet0 (then wallet1, ...)
defi-tool wallet add 0xYourWallet --chain base --name my-wallet1
defi-tool wallet add YourSolanaAddress --chain sol --name phantom
defi-tool wallet list                                         # table; --json for scripts
defi-tool wallet edit my-wallet1 --name base-main             # rename; --chain moves it to another network
defi-tool wallet delete base-main                             # alias: wallet rm
defi-tool positions list --wallet wallet0,base-main            # see Your positions
```

- `--chain` is required and names exactly one network. EVM addresses (`0x` + 40 hex characters) go on EVM networks and are stored lowercase; Solana addresses (base58) go on Solana, case kept. An EVM address is the same on every EVM network, so save it once per network you use, or pass `--chain` to `positions`.
- Names have up to 30 letters, digits, `.`, `_` or `-`, and ignore letter case (`wallet edit MAIN` finds `main`). Without `--name`, the first free `wallet0`, `wallet1`, ... is used. A name and an address/network pair can each be saved only once.
- `wallet list` shows each wallet's name, network, type (EVM/Solana), address, when it was added and last edited, and the open Uniswap positions found by the last `positions` or `alerts` run, with that run's time. Listing makes no network requests.
- `wallet delete` removes only the saved wallet; position and alert history stays in the database. To change an address, delete the wallet and add it again.
- `positions list --wallet` takes saved names, each read on its saved network (`--wallet-addr` takes addresses). `positions analyze` and `alerts` accept saved names or addresses in `--wallet`. A saved wallet is checked on its own network unless `--chain` is given; an address uses `--chain` or the networks saved by `init`. Without `--wallet`, every saved wallet is checked, plus any addresses saved by `init` or `DEFI_TOOL_WALLETS`. Solana wallets are skipped with a note, because positions are Uniswap NFTs on EVM networks.
- Wallets live in the SQLite database (`wallets` table), next to the cache: `~/.local/share/defi-tool/state.db` or `DEFI_TOOL_DB_PATH`. Only public addresses are stored.

## Configuration

`init` guides terminal users through chains, wallets, and optional RPC URLs; it does not ask for an API key. `defi-tool wallet add` is the easier way to save wallets: by name and network, editable later. Non-interactive callers can supply flags; remaining settings use defaults. Use real `0x` wallet addresses with 40 hexadecimal characters.

Configuration is stored in `~/.config/defi-tool/config.json` with mode `0600`; the default SQLite database is `~/.local/share/defi-tool/state.db`. Installations from before the rename used `~/.config/uniswap-tools/` and `~/.local/share/uniswap-tools/`; move those folders to the new names to keep your settings and cache. Rerunning `init` requires `--force` to replace existing settings. To keep existing settings, edit the file directly.

Use `--config /path/config.json` or `DEFI_TOOL_CONFIG` to choose a different configuration. Environment overrides include `DEFI_TOOL_DB_PATH` and `DEFI_TOOL_WALLETS` (comma-separated addresses). These were `UNISWAP_CONFIG`, `UNISWAP_DB_PATH` and `UNISWAP_WALLETS` before the rename; `UNISWAP_API_URL` and `UNISWAP_API_KEY` keep their names because they configure the Uniswap GraphQL provider.

RPC environment variables use network names:

```bash
export RPC_URL_ETH=https://your-ethereum-provider
export RPC_URL_ARB=https://your-arbitrum-provider
export RPC_URL_OP=https://your-optimism-provider
export RPC_URL_BASE=https://your-base-provider
export RPC_URL_POLYGON=https://your-polygon-provider
export RPC_URL_BNB=https://your-bnb-provider
export RPC_URL_ROBINHOOD=https://your-robinhood-provider
```

These URLs are optional: position reads use the public defaults in viem's chain registry when no URL is supplied. Public RPCs can be slow or rate-limited. Legacy `RPC_URL_1`, `RPC_URL_42161`, etc. remain supported. Named RPC variables take precedence over numeric ones, and environment settings override the saved file. Bulk pool scans only enrich with RPC when you explicitly configure a URL.

## Optional custom provider

The default source is `public`. Existing configurations with a non-default custom `apiUrl` retain their custom provider behavior. Force public data with `--source public`; this ignores any saved API key and custom URL, unless a URL override is explicitly supplied on the command line.

For pool commands, `--source public` is DefiLlama and `--source geckoterminal` is GeckoTerminal; both are key-free. `--source custom` or an explicit `--api-url` selects the existing custom GraphQL adapter. It requires an endpoint implementing that adapter's schema, **not** an arbitrary Uniswap Trading API key. `UNISWAP_API_URL` and `UNISWAP_API_KEY` remain available for this optional integration. Keys are sent only to the custom GraphQL provider, never to GeckoTerminal or RPC endpoints by the CLI. Public sources do not automatically fall back to a paid/keyed provider.

## Results and current limits

Tables display network names and readable position states. `--json` preserves the existing machine-readable schema, including numeric chain IDs. Alerts run on demand and are deduplicated locally. Alert exit codes are `0` for no new alerts, `2` for new alerts, and `1` for command failure. Unknown range status means missing data, not a healthy position. Partial provider failures are reported on stderr; complete discovery failure returns exit code `1`.

Pool data comes from the [DefiLlama yields API](https://defillama.com/docs/api) by default: one download (about 10 MB, 60-second timeout) per run serves every selected network. `--source geckoterminal` uses the [GeckoTerminal public API](https://apiguide.geckoterminal.com/) instead (v3 and v4 only, no 7D volume; APR is computed from the fee tier in the pool name), with request spacing and a 15-second timeout. Connection failures and server errors are retried once; HTTP 429 reports the rate limit and asks you to retry. DefiLlama rows have no pool contract address, so JSON `pool.id` is DefiLlama's pool ID and token addresses are in `token0`/`token1`. No authentication or scraping of Uniswap's website is used. The CLI does not report unavailable fees, realized volatility, or hook details as measured data; confidence drops for those missing inputs. V4 hook behavior is marked unknown when not available.

`positions analyze` and alerts read current ticks, range bounds, and liquidity over RPC; `positions list` adds prices, balances, fees and PnL (see [Your positions](#your-positions)). V3 automatic enumeration is limited to wallets with at most 500 NFTs; use `--position` for larger wallets. V4 reads use the official per-chain PositionManager and StateView deployments. Tests validate these flows with local REST/RPC fixtures; they do not certify uptime of every live public endpoint. Scores are heuristics, not guaranteed yields.

The optional custom API adapter in `src/providers/uniswap-api.ts` retains its provisional GraphQL schema and must be matched to your own endpoint. Storage and alert identities now include chain and protocol to prevent collisions between NFT IDs; previously stored alerts may be emitted once again under the corrected identity.

## Development

```bash
npm run build
npm run dev -- positions --help
```

Run everything with `npm test`. `DEFI_TOOL_DEXSCREENER_URL`, `DEFI_TOOL_REVERT_URL` and `DEFI_TOOL_PRICES_URL` point DexScreener, Revert Finance and DefiLlama price lookups at test servers. Targeted provider checks: `node --import tsx --test tests/defillama-pools.test.ts tests/public-pools.test.ts tests/output.test.ts tests/rpc-positions.test.ts tests/analytics.test.ts tests/storage.test.ts`. CLI checks: `node --import tsx --test tests/config.test.ts tests/cli.test.ts tests/install.test.ts`. The project uses built-in `node:sqlite`, avoiding a native SQLite addon.

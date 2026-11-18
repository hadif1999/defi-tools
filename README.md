# defi-tool

A read-only DeFi CLI: pool discovery and ranking for Uniswap, PancakeSwap, Aerodrome and Curve (EVM chains) and Raydium (Solana), Uniswap LP position analysis and on-demand alerts, historical price candles for any of those pools and for the market as a whole, a live pool ticker, and transaction plans for new Uniswap v3 positions that your own wallet signs.

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
defi-tool positions create --help
defi-tool alerts check --help
defi-tool dex-data download --help
defi-tool dex-data show --help
defi-tool market-data download --help
defi-tool dex-ticker --help
defi-tool init --help
```

Root and command groups show help when invoked without a subcommand. Each command's help includes examples, defaults, and relevant cautions.

## Explore pools

`pools scan` mirrors the [Uniswap Explore pools page](https://app.uniswap.org/explore/pools): v2, v3, and v4 pools on each network, sorted by TVL by default.

```text
$ defi-tool pools scan --chain eth --top 3
Source: DefiLlama public data (no API key) · Ethereum · 2026-10-29 09:21 UTC
Pools sorted by TVL, highest first

#  Pool           Chain     DEX      Version     Fee      TVL  1D vol   7D vol  1D vol/TVL    APR  1D txns   Age
─  ─────────────  ────────  ───────  ───────  ──────  ───────  ──────  ───────  ──────────  ─────  ───────  ────
1  DAI/USDC/USDT  Ethereum  Curve    AMM           —  $160.0M  $48.6M        —        0.30  0.00%        —     —
2  WISE/WETH      Ethereum  Uniswap  v2         0.3%  $131.0M  $27.7K   $55.6K       <0.01  0.02%        3  5.8y
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
defi-tool positions list                                   # the default wallet, on every network (see Wallets)
defi-tool positions list --wallet all                      # every saved wallet
defi-tool positions list --wallet my-wallet1               # saved wallet(s) by name; the network comes from the wallet
defi-tool positions list --wallet-addr 0xYourWallet        # any address, on every network
defi-tool positions list --wallet-addr 0xYourWallet --chain base,arb --past --top 10
defi-tool positions list --active --json
```

```text
Uniswap positions · ledger1 (0x902e…3f00) on Ethereum, Optimism, Polygon, Base, Arbitrum
Source: Revert Finance (no API key) · 2026-10-29 09:21 UTC
Open: 0 (value $0.00, unclaimed fees $0.00) · Closed: 4 · Lifetime fees $5.19 · PnL -$17.67

Open positions (0)
  No open positions.

Closed positions (4) · most recently closed first
#  Chain     Pool                      ID  Range (min – max)    Exit price  Price now  Unit           Deposited  Withdrawn  Fees earned    Gas  Fee APR              PnL      IL  Opened      Closed      Held
─  ────────  ──────────────────  ────────  ───────────────────  ──────────  ─────────  ─────────────  ─────────  ─────────  ───────────  ─────  ───────  ───────────────  ──────  ──────────  ──────────  ────
1  Arbitrum  WETH/USDC 0.05% v3  #5723933  2,354.34 – 2,570.90    2,305.85   2,320.00  USDC per WETH     $78.36     $74.54        $2.81  $0.05   63.71%   -$1.06 (-1.4%)  -$1.28  2026-10-08  2026-10-29   20d
2  Base      WETH/USDC 0.3% v3   #6285249  2,330.91 – 2,596.73    2,312.36   2,317.97  USDC per WETH     $96.25     $91.98        $2.07  $0.02   57.99%   -$2.21 (-2.3%)  -$1.35  2026-10-15  2026-10-29   13d
3  Base      XDP/USDC 0.01% v3   #6236772  0.02200 – 0.03271       0.02167    0.01915  USDC per XDP      $71.36     $61.26        $0.19  $0.02   94.66%  -$9.93 (-13.9%)  -$3.31  2026-10-11  2026-10-12   25h
4  Ethereum  AAVE/WETH 0.3% v3   #1373723  0.05131 – 0.06406       0.05655    0.05636  WETH per AAVE    $100.03     $97.95        $0.11  $2.51   24.15%   -$4.47 (-4.5%)  -$0.07  2026-09-26  2026-09-28   40h
```

- **Open table:** current price, range (min – max), status (`● In range`, `▼ Below x%`, `▲ Above x%`), token balance, value, unclaimed fees, fees earned, fee APR, PnL and age, largest value first.
- **Closed table:** range, exit price (pool price at the last withdrawal), price now, deposited, withdrawn, fees earned, gas, fee APR, PnL, impermanent loss (IL), opened and closed dates and time held, most recently closed first.
- **Prices** use a stablecoin, then the wrapped native coin, as the quote when the pair has one (`USDC per WETH`, `WETH per AAVE`); the Unit column says which.
- **Figures:** deposits, withdrawals, fees and gas are valued in USD at the time each happened. PnL = value now + withdrawals + fees − deposits − gas. Fee APR = fees earned ÷ deposits, annualized over the time held. IL (impermanent loss) compares the position with holding the deposited tokens, fees excluded: the tokens it returned minus the tokens deposited, both valued at the exit price for a closed position (later price moves affect the tokens either way) or today's price for an open one. It is not withdrawals minus deposits, which also counts the market's move; Revert's own `il` figure is that, so it is used only when amounts or prices are missing.
- **Options:** `--active` or `--past` shows one table (both by default). `--top` limits each table (default 100, up to 1000). `--chain` narrows the networks. `--wallet` takes saved names (see [Wallets](#wallets)) or `all`; `--wallet-addr` takes addresses. Both are read on every EVM network, whatever network a wallet was saved for: an EVM address is the same account everywhere, and Revert answers for all networks in one request. Without either, the **default wallet** is read (see `wallet set-default`), or the addresses saved by `init` when no wallet is saved. Solana wallets are skipped with a note. `--json` prints `{ "data": { "active": [...], "past": [...] } }`.
- **Data source:** [Revert Finance](https://revert.finance)'s public positions API, without a key: one request per address finds open and closed positions on every network, with their full history. Uniswap's own APIs do not list positions (the Trading API key is not used), and free public RPCs cannot search an address's history on L2s. Revert is a third-party service: its data can lag by a few minutes.
- **Fallback:** if Revert cannot be reached (or with `--source rpc`), the position NFTs the wallet still holds are read over public RPC, with USD prices from DefiLlama: price, range, status, balance and unclaimed fees are shown, but deposits, fees collected, PnL and dates are not, and burned NFTs are missed. Columns without any value are left out. `--source revert` fails instead of falling back. On-chain reads cover v3; v4 NFTs cannot be enumerated without an indexer.
- No private key is ever requested.

### One position in depth: `positions detail`

```bash
defi-tool positions detail 1                          # row 1 of positions list (open positions; closed ones when none are open)
defi-tool positions detail 2 --past                   # row 2 of the closed table
defi-tool positions detail '#5723933' --output html   # by NFT ID, as an interactive report in the browser
defi-tool positions detail 5723933 --no-plot          # tables only, no charts
defi-tool positions detail 1 --wallet my-wallet1      # a position of another saved wallet (default: the default wallet)
defi-tool positions detail 1 --json                   # the whole analysis and its candles
```

The argument is an NFT ID (`#5723933` or `5723933`) or a row number of `positions list`; an ID wins when both could match, and `--chain` picks between the same ID on two networks. The wallet is the default wallet unless `--wallet` (saved names, or `all`) or `--wallet-addr` names others, read as for `list` (`--chain`, `--source` too). `detail` is also available as `show`.

```text
WETH/USDC 0.05%  Uniswap v3 · Arbitrum · position #5723933 · 0x902e…3f00
■ Closed 2026-10-29 · exit price 2,305.85

 ◆ 2,354.34 ├─────────────────────────▴──────────────────────────────────┤ 2,570.90
   ◆ exit 2,305.85 · ▴ entry 2,442.87 · width 9.2% · USDC per WETH
```

- **Status and range gauge:** in range (how far through it), below or above (by how much, and which token it now holds), or closed with its exit price; the gauge places the price, entry and limits on a log scale.
- **Charts** (on by default, `--no-plot` to leave out): the pool's candles with the range shaded, the lower and upper limits, entry, exit, breakeven and live price as lines, and each deposit (▲), fee collect ($) and withdrawal (▼) under its candle; then the position's **value against price** next to holding the tokens it had at entry, from its liquidity (the deposit's, for a closed position).
- **Range:** limits, distance from the price to each, width, limits relative to entry, ticks and tick spacing, and concentration (how many times the capital a full-range position needs for the same liquidity).
- **Holdings / tokens:** what an open position holds and its value split; for a closed one, the tokens deposited, withdrawn and collected, and the net change.
- **Performance:** deposits, withdrawals, fees earned (per day), gas, PnL, impermanent loss and how much of it the fees covered, the result against holding the deposited tokens, fee and total APR, and for an open position the **breakeven** price above which lifetime PnL is positive.
- **Time:** opened, closed, held, **time in range** and range exits (candle closes while open), high and low, volatility, and for an open position the typical time a move takes to reach each limit ((distance ÷ daily volatility)² days, not a forecast).
- **What if the price moved now** (open positions): at −50% to +50% and at each limit, the tokens held, value, result against holding, and lifetime PnL.
- **Transactions:** every deposit, fee collect and withdrawal with amounts, price, USD value, gas and an explorer link.
- **`--output html`** writes the same as a report page (`<data-dir>/positions/position-<id>_<chain>.html`, or `--html-file`) and opens it (`--no-open` to skip): key-figure tiles, the range gauge, an interactive price chart (zoom, pan, hover values, 15m/1h/4h/1D) with the range band drawn for the time the position was open, value-against-price and impermanent-loss curves with a shared hover readout, the holdings donut, a PnL attribution waterfall (market move, liquidity effect, fees, gas), and the tables. It works offline and has light and dark themes.
- **Candles** come from GeckoTerminal through the same cache as `dex-data show` (`--data-dir`, default `dex-data`; `--offline` uses the cache only). `--timeframe auto` picks 15m, 1h, 4h or 1d for how long the position was open; older than 180 days and not cached means the chart and time in range cover less.

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

## Create a position

`positions create` plans a new Uniswap v3 position on **Base** or **Arbitrum** and builds the transactions for your wallet to sign. It never signs or sends anything, so the CLI stays read-only.

```bash
defi-tool positions create WETH/USDC --chain base --wallet my-wallet --amount 100usd --lower-limit -15% --upper-limit +10%
defi-tool positions create WETH/USDC --chain arb --fee 0.05 --wallet 0xYourWallet --amount 0.05weth --lower-limit 2000 --upper-limit 2700
defi-tool positions create cbBTC/USDC --chain base --wallet my-wallet --amount max --lower-limit -20% --upper-limit +20% --signer raw
defi-tool positions create --pool 0xPoolAddress --chain base --wallet my-wallet --amount 50usd --full-range --json
```

- **Range:** `--lower-limit` and `--upper-limit` need not be symmetric. Each is a percentage from the current price (`-15%`, `+10%`) or a price (`2100`), in the unit shown, which quotes the stablecoin or wrapped native coin (`USDC per WETH`). Ticks are widened outward to the pool's tick spacing, so the range is never narrower than asked. `--full-range` covers every price. A range that leaves out the current price starts out of range with one token, which the plan points out.
- **Amount:** a USD total (`100usd`, `$100`) split by the range; one token's amount (`0.05weth`, `150usdc`), with the other worked out from the range; or `max`, the most the wallet's balances can fund.
- **Pool:** the pair (symbols such as WETH, USDC, cbBTC, wstETH, ARB, or any token address) and `--fee 0.01|0.05|0.3|1`. Without `--fee`, the pool holding the most liquidity is used, and the other tiers are named. `--pool` takes a pool address instead.
- **Exact math:** ticks, liquidity and token amounts use Uniswap's integer formulas (TickMath and LiquidityAmounts). Pool price, tick spacing, token decimals, balances and allowances are all read on-chain when the plan is built.
- **Safety:** minimum amounts follow the Uniswap SDK's slippage method (`--slippage`, default 0.5%), and the mint expires after `--deadline` (default 20m). Approvals are added only when the allowance is short, and only for the amount needed (`--approve unlimited` to change that). USDT-style allowances are reset to 0 first. When no approval is needed, the mint is simulated from your wallet: a failure shows the node's revert reason; a success shows the NFT ID it would mint and the gas. After signing approvals, run the command again: the mint is rebuilt at the latest price and simulated.
- **Native ETH:** with `--pay-with auto` (the default), the WETH side is paid in ETH when the wallet lacks WETH, keeping 0.0005 ETH for gas. The mint then wraps the ETH and refunds what it does not use. `--pay-with weth` or `eth` forces a choice.
- **Volatility check:** 30 days of DefiLlama prices give the pair's daily volatility and how soon a typical move reaches each limit. Ranges a typical move leaves within a week get a warning, and so does the 0.01% tier for pairs that are not stablecoins.
- **Signing:** `--signer mm` (default) prints a `mm wallet send-transaction` command per step for the MetaMask agent wallet CLI. `--signer raw` prints `to`, `value` and `data` for any other wallet. `mm decode --payload <data>` decodes any step for review. Ledger's wallet-cli cannot send contract calls on Base or Arbitrum. `--wallet` must be the address that signs: it pays the tokens and receives the position NFT.

## Wallets

Save wallets once by name, then refer to them in `positions` and `alerts`, or set one as the default so you can leave out `--wallet`:

```bash
defi-tool wallet add 0xYourWallet --chain eth                 # saved as wallet0 (then wallet1, ...)
defi-tool wallet add 0xYourWallet --chain base --name my-wallet1
defi-tool wallet add YourSolanaAddress --chain sol --name phantom
defi-tool wallet list                                         # table with balances and the default marked; --no-balance, --json
defi-tool wallet set-default my-wallet1                       # or its number in wallet list, or its address
defi-tool wallet set-default                                  # show the current default
defi-tool wallet history ledger1                               # latest transactions (see Wallet history)
defi-tool wallet edit my-wallet1 --name base-main             # rename; --chain moves it to another network
defi-tool wallet delete base-main                             # alias: wallet rm
defi-tool positions list --wallet wallet0,base-main            # see Your positions
```

- `--chain` is required and names exactly one network. EVM addresses (`0x` + 40 hex characters) go on EVM networks and are stored lowercase; Solana addresses (base58) go on Solana, case kept. An EVM address is the same on every EVM network, so save it once per network you use, or pass `--chain` to `positions`.
- Names have up to 30 letters, digits, `.`, `_` or `-`, and ignore letter case (`wallet edit MAIN` finds `main`). `all` is reserved: wherever a wallet is named, `all` means every saved wallet. Without `--name`, the first free `wallet0`, `wallet1`, ... is used. A name and an address/network pair can each be saved only once.
- `wallet list` shows each wallet's name, network, type (EVM/Solana), address, live balance, and when it was added and last edited. **Balance** is the USD value at DefiLlama prices; **Holdings** lists the native coin plus well-known tokens with a balance (WETH, USDC, cbBTC, wstETH, ... on Base and Arbitrum; native coin only elsewhere; SOL only on Solana, via its public RPC or `rpcUrls["501"]` in the configuration). A wallet that cannot be read shows `—`, with the reason on stderr. `--no-balance` skips the network requests; `--json` adds `balance` (or `balanceError`) to each wallet.
- `wallet delete` removes only the saved wallet; position and alert history stays in the database. To change an address, delete the wallet and add it again.
- **Default wallet:** every command that takes `--wallet` uses the default wallet when it is left out: `positions list`, `detail`, `analyze` and `create`, `alerts check`, and `wallet history`. The default is the wallet chosen with `wallet set-default` (by name, by its `#` in `wallet list`, or by address, with `--chain` if the address is saved on several networks); until you choose one, it is the most recently added wallet. Renaming the default keeps it; deleting it falls back to the most recently added. Commands say on stderr which default they used. `wallet list` marks it `★ default` (or `★ latest` when none was chosen), and `--json` adds `"default": true`. `--wallet all` (or `wallet history all`) reads every saved wallet, plus, for positions and alerts, addresses saved by `init` or `DEFI_TOOL_WALLETS`; `all` also works inside a list (`all,main`). It is refused where only one wallet makes sense: `positions create` and `wallet set-default`. With no saved wallets, the `init` addresses are used as before.
- **Networks:** `positions list` and `detail` read a saved EVM wallet (`--wallet`, or the default) on every EVM network, as `--wallet-addr` addresses; `--chain` narrows them. `positions analyze` and `alerts`, which read each network over RPC, check a saved wallet on `--chain`, or on the networks saved by `init` plus the wallet's own network; an address uses `--chain` or the networks saved by `init`. Solana wallets are skipped with a note, because positions are Uniswap NFTs on EVM networks.
- Wallets live in the SQLite database (`wallets` table), next to the cache: `~/.local/share/defi-tool/state.db` or `DEFI_TOOL_DB_PATH`. Only public addresses are stored.

## Wallet history

`wallet history` lists a wallet's latest transactions as a table: swaps, liquidity adds and removes, fee collects, sends, receives, and wraps. Each row shows what moved, its USD value when it happened, and the gas paid.

```bash
defi-tool wallet history                                     # the default wallet, on its saved network, last 30 days
defi-tool wallet history all --type lp                       # every saved EVM wallet, one section each
defi-tool wallet history ledger1                             # the saved wallet's network, last 30 days
defi-tool wallet history ledger1 --chain base,arb --days 90
defi-tool wallet history ledger1 --type swap --top 20
defi-tool wallet history 0xYourWallet --type lp --json       # an address: every network unless --chain
```

```text
Wallet history · ledger1 (0x902e…3f00) on all networks · last 60 days
Source: Revert Finance · 2026-10-29 11:32 UTC
10 transactions: 4 add liquidity, 4 remove liquidity, 2 collect fees
added $346.00 · removed $325.73 · fees collected $5.19 · gas $2.60

 #  Time (UTC)        Chain     Type              Details                                                     Value    Gas  Tx
 1  2026-10-29 07:27  Arbitrum  Remove liquidity  WETH/USDC 0.05% v3 #5723933 → 0.03233 WETH                 $74.54  $0.01  0x8e6d…0b8e
 2  2026-10-29 07:26  Arbitrum  Collect fees      WETH/USDC 0.05% v3 #5723933 → 0.000003721 WETH + 0.0078 USDC  $0.02  $0.01  0xc081…05de
```

- **Sources:** liquidity activity (Uniswap v3/v4 adds, removes and fee collects, with exact amounts and prices) comes from Revert Finance, without a key. Swaps, sends, receives and wraps come from Alchemy's Transfers API, which needs a **free key**: `export ALCHEMY_API_KEY=...` from https://dashboard.alchemy.com, or `alchemyApiKey` in the configuration file. No key-free service lists history on Base or Arbitrum: public RPCs limit log searches to hours of blocks. Without a key, the command shows liquidity activity and says so. Alchemy covers Ethereum, Optimism, BNB Chain, Polygon, Base and Arbitrum. The key is sent only to Alchemy.
- **One row per transaction.** Transfers in one transaction are grouped and classified. Sending one token and receiving another is a **swap**. ETH ⇄ WETH is a **wrap** or **unwrap**. One direction only is a **send** or **receive**, showing the other address. A liquidity transaction found by both sources is taken from Revert.
- **Values** are USD at the time of each transaction, from DefiLlama's historical prices (closest within 6 hours). Swaps also show received minus sent, e.g. `(-$0.08)`: what the trade cost in price impact, pool fees and MEV. The summary adds up swap volume and cost, liquidity added and removed, fees collected, and gas for the rows shown.
- **Gas** counts only transactions this wallet sent, from receipts. It includes the L1 data fee on rollups.
- **Spam:** receipts of tokens that are neither well known nor priced by DefiLlama are likely unsolicited airdrops. They are hidden and counted; `--all` shows them.
- **Options:** `--chain` (default: the saved wallet's network; every EVM network for a plain address), `--days` 1–365 (default 30), `--type` with `swap`, `add-liquidity`, `remove-liquidity`, `collect-fees`, `send`, `receive`, `wrap`, `unwrap`, `other`, or `lp` for all three liquidity kinds, `--top` 1–500 (default 50), `--json` (full hashes and explorer links). Alias: `wallet tx`.
- **Not listed:** approvals and other transactions that moved no tokens, NFT transfers, and Solana wallets.

## DEX data

`dex-data download` saves historical price candles (open, high, low, close, volume) for specific DEX pools as files, checked and gap-filled, ready for charts or analysis.

```bash
defi-tool dex-data download WETH/USDC --chain base                       # 1h candles, last 30 days, CSV
defi-tool dex-data download WETH/USDC,cbBTC/USDC --chain base --fee 0.05 --timeframe 15m --from 7d
defi-tool dex-data download ETH/USDC --chain eth,arb --protocol v3,v4 --format parquet --out-dir ./data
defi-tool dex-data download WETH/USDC --chain arb --from 2026-09-01 --to 2026-10-01 --timeframe 1d --quote usd
defi-tool dex-data download SOL/USDC --chain solana --dex raydium --protocol clmm
defi-tool dex-data download --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --dry-run
```

```text
DEX data · 15m candles · 2026-10-09 12:00 – 2026-10-29 11:45 UTC
Source: GeckoTerminal public API (no key)

#  Pair       Chain  Pool                            TVL  Unit           Candles  Filled  Dropped  Jumps  First candle
1  WETH/USDC  Base   USDC / WETH 0.05% v3 Uniswap  $8.3M  USDC per WETH    1,919       0        0      0  range start

WETH/USDC: dex-data/WETH-USDC_base_uniswap-v3-0.05_0xd0b53d_15m_20261009-1200_20261029-1145.csv, …csv.meta.json
```

- **Source:** [GeckoTerminal's public OHLCV API](https://apiguide.geckoterminal.com/), without a key. It serves the **last 180 days** only (older requests fail with a clear message) and at most 1,000 candles per request, so longer ranges are fetched page by page, newest first. Requests are spaced about 2 seconds apart (the public limit is about 30 a minute); a rate-limit response waits 20 s, 40 s, 80 s and retries. `--dry-run` shows the pools chosen and the number of requests without downloading.
- **Pool:** each pair (symbols or addresses, either order; `ETH` matches `WETH`, `SOL` matches `WSOL`) uses the deepest pool matching `--dex` (default `uniswap`), `--protocol` (default `v3`) and `--fee` (default any tier) on the `--chain` networks (default: saved chains). The summary names the next pools so you can pick another with `--fee`, `--protocol`, or `--pool <address>` (v4 pool IDs work too; needs one `--chain`).
- **Time:** `--timeframe` `1m`, `5m`, `15m`, `1h` (default), `4h`, `12h`, `1d`. `--from` (default `30d`) and `--to` (default `now`) take a duration ago (`30d`, `12h`, `2w`), a UTC date (`2026-10-01`) or date-time (`2026-10-01T12:00`, an offset is allowed), or unix seconds. Times are UTC and each candle's time is the start of its period; the range is aligned to the timeframe. The newest candle is left out while its period is still running, unless `--include-partial`.
- **Prices:** `--quote auto` (default) prices in the more money-like token: a stablecoin, then the native coin, then BTC (`USDC per WETH`), as `positions list` does. `--quote usd` gives USD prices; `--quote WETH` names the quote token. Volume is in the same unit.
- **Checks:** rows that are malformed, not aligned to the timeframe, with zero or negative prices, negative volume, or a high/low that does not contain the open and close are dropped and counted by reason. Repeated periods are merged; GeckoTerminal returns a partial copy of the candle at each page boundary, which is skipped. Closes more than 50% from the previous close are counted as **jumps** to look at, not removed.
- **Gaps:** GeckoTerminal sends no candle for a period without trades. `--fill forward` (default) adds one at the previous close with zero volume and `filled=true`, since a pool's price cannot move without a trade; `--fill none` leaves them out. Periods before the first trade in the range are never filled; the summary says when the data starts late.
- **Files:** `--format csv` (default), `json` (metadata and candles in one document), `jsonl` (one candle per line) or `parquet` (`time` as a timestamp, prices and volume as doubles, `filled` as a boolean). Columns: `time` (ISO 8601 UTC), `timestamp` (unix seconds), `open`, `high`, `low`, `close`, `volume`, `filled`. Files go to `--out-dir` (default `./dex-data`), named by pair, network, exchange, version, fee, pool address prefix, timeframe and range. Each file except JSON gets a `.meta.json` beside it with the pool, tokens, units, range, request count and every check above (Parquet also carries it in its footer). Existing files are kept unless `--force`.
- `--json` prints the summary as JSON. A pair that fails is reported on stderr while the others continue; the exit code is `1` only when every pair fails.

### Charts: `dex-data show`

`dex-data show` charts a pool's candles together with its live ticker: as a candlestick chart in the terminal (default), or as an interactive page in your browser (`--output html`).

```bash
defi-tool dex-data show WETH/USDC --chain base                              # all time, 1h candles, in the terminal
defi-tool dex-data show WETH/USDC --chain base --fee 0.05 --timeframe 15m --from 3d
defi-tool dex-data show WETH/USDC --chain base --output html                # opens in your browser
defi-tool dex-data show cbBTC/USDC --chain base --timeframe 1d --output html --html-file ./cbbtc.html --no-open
defi-tool dex-data show WETH/USDC --chain base --offline                    # cached data only, no network
defi-tool dex-data show --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --timeframe 4h --json
```

```text
WETH/USDC  2,337.22 USDC per WETH  24h -1.12%  H 2,390.19  L 2,291.41  Vol $12.9M  Liq $8.3M  Uniswap v3 0.05% on Base
WETH/USDC  Uniswap v3 0.05% · Base · 0xd0b5…f224 · USDC per WETH
1h candles · 2026-10-26 20:00 – 2026-10-29 19:00 UTC

                           ╷       │╷    ╷││ ╷    ┃ ╿┃ ╽        │ ┃┃ ╽╻╷ │                    ┃┃    │
                           │ │ │   ││  ╷ │╽╽ ╽╷ ╷╽┃ ╵│ ╿┃       ╽ ┃╿ ╿╿╿ ┃╷                   ┃┃ ╷│ ┤ 2,357.87
      │               │ │  ┃╿╹ ╿╿ ┃┃│ ╵╿ ╿    │ │       ┃│ │╷ ╷┃╿         ┃     │           ┃ ╹  ┃│ ┤ 2,341.76
┈┈┈┈┈┈││┈┈┈┈┈┈┈┈┈┈┈┈┈╷┃┈┃╽┈┃┈┈┈┈┈┈┈╵┈┈┈┈┈┈┈┈┈┈┈┈╵┈┈┈┈┈┈┈╿┃┈╽╽┈╽┃┈┈┈┈┈┈┈┈┈┈┃┈┈┈┈┈│┈┈┈┈╷┈┈╷┃┈┈┈┈╿┃ ◀ 2,337.22
 ╷  ╻ ╽╽│  ╷ ╷   │  ╷│┃ ┃┃ ╵                             │ │╵ ││          ┃  │╷ ╽╽ │││ ┃┃ ╽╽┃     ╿ ┤ 2,325.65
───────────────────────────────────────────────────────────────────────────────────────────────── ┤ volume
▄▄ ▃▄ ▃▆▄ ▃▂ ▄▃▅ ▄▃ ▇▃▆ ██ █▄▄ ▃▃ ▂▆▃ ▂▂ ▄▄▂ ▂▁ ▁▁█ ▂▂ ▃█▇ ▇▃ ▅▅█ ██ ▅▄▂ ▂█ █▄▃ ▄▃ ▃▅▃ ▃▂ ▅██ ██ █▇
10-26 20:00   10-27 06:00   10-27 16:00   10-28 02:00   10-28 12:00   10-28 22:00   10-29 08:00

Change +0.59%   High 2,392.11 2026-10-28 09:00   Low 2,291.41 2026-10-29 02:00   Volume 34.7M USDC   Volatility 41%/yr   Candles 71
Data: 1 cached file · GeckoTerminal
```

- **Cache first:** `show` reads the files `dex-data download` saved in `--data-dir` (default `./dex-data`) for the same pool and price unit, whatever their format. Files at the requested `--timeframe` are used as they are; finer ones whose size divides it are combined into it (15m files make a 1h chart), keeping only whole periods. Where files overlap, the most recent download wins, and real candles beat filled ones.
- **Then download:** stretches the cache does not cover, within GeckoTerminal's 180 days, are downloaded and saved to the cache as ordinary `dex-data download` files (CSV with `.meta.json`), so the next `show` is instant and history older than 180 days stays viewable after GeckoTerminal drops it. `--refresh` downloads the available range again; `--offline` uses only the cache and finds the pool among cached files (also the fallback when GeckoTerminal cannot be reached). Ranges no source has are named under the chart.
- **Range:** without `--from`, `show` covers all time: everything cached for the pool plus GeckoTerminal's 180 days. `--from`/`--to` take the same forms as `download`; only finished periods are shown. Pool choice (`--chain`, `--dex`, `--protocol`, `--fee`, `--pool`) and `--quote` work as in `download`.
- **Live ticker:** the `dex-ticker` line (price, 24h change, high, low, volume, liquidity) heads the view, and the live price is drawn across the chart (a dotted line marked `◀` on the axis; a dashed `live` line in HTML). When it cannot be read, the view says why and still shows the chart.
- **Terminal (`--output terminal`, default):** a candlestick chart sized to your terminal (`--width`, `--height` to override): each row holds two price levels, bodies are heavy lines and wicks light ones, green rose, red fell, grey had no trades; volume bars below (`--no-volume` to hide), a price axis, and time labels. Long ranges merge consecutive candles per column, and the header says how many; short ones spread out over the width. Below it: change over the range, high and low with their times, volume, annualized volatility (from close-to-close returns), the candle count with quiet periods, and where the data came from. Colors follow `--no-color`, `NO_COLOR` and whether the output is a terminal.
- **HTML (`--output html`):** a TradingView-style chart workspace in one self-contained file (the [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) library and the workspace's script and styles from `assets/chart/` are embedded, so it works offline and can be shared), saved to `--html-file` (default `<data-dir>/charts/<pair>_<chain>_<pool>_<timeframe>.html`) and opened in your default browser unless `--no-open`.
  - **Layout:** a top bar (pair, timeframes, chart type, indicators, undo/redo, live price, screenshot, full screen, theme, details panel), the drawing tools on the left, a details panel on the right (live ticker with the 24h range, figures for the visible range and for all loaded data, pool, data sources, shortcuts), and a bottom bar with range presets (1D, 5D, 1M, 3M, 6M, All), a UTC clock and the price scale modes (`%`, `log`, `auto`).
  - **Hover:** the legend shows the candle under the crosshair (open, high, low, close, change, time) and every indicator's value at that bar; the crosshair labels the price and time on the axes.
  - **Drawing tools:** trend line, ray, horizontal and vertical lines, rectangle, Fibonacci retracement, measure (price change, percent, bars and time), long and short positions (entry, target and stop with risk/reward), and text notes. Draw by click-drag or click-click; a magnet snaps to open, high, low or close. Drag a drawing to move it or its handles to reshape it; a floating bar sets its color, width and line extension, and locks, clones or deletes it. Drawings are anchored to time and price, so they keep their place across zoom, timeframes and chart types, and they are saved in the browser per pool (as are the indicators, chart type, scale and theme). Lock or hide all drawings, stay in drawing mode, undo and redo (Ctrl+Z, Ctrl+Y).
  - **Chart:** candles, hollow candles, Heikin Ashi, bars, line or area; timeframes from the loaded one up (built in the page); indicators MA, EMA, Bollinger Bands and daily VWAP on the price, and volume, RSI (0–100 with 30/70 bands) and MACD in their own resizable panes, each with editable settings and removable from the legend. Zoom with the wheel or by dragging the axes, scroll to the latest bar, take a PNG screenshot with the drawings, or go full screen.
  - **Keyboard:** Alt+T trend, Alt+R ray, Alt+H horizontal, Alt+V vertical, Alt+B rectangle, Alt+F Fibonacci, Alt+M measure, Alt+L long, Alt+S short, Alt+N note, Alt+G magnet, Del delete, Esc back to the cursor.
- `--json` prints the pool, price unit, range, figures, live ticker, sources and every candle.

## Market data

`market-data download` saves the market price of coins and pairs, blended across all venues, as candles (open, high, low, close). It is about the market itself rather than one pool: for a specific DEX pool's prices, use [`dex-data`](#dex-data).

```bash
defi-tool market-data download ETH                                        # ETH in USD, 1h candles, last 30 days, CSV
defi-tool market-data download ETH,BTC,SOL --timeframe 15m --from 7d
defi-tool market-data download BTC/ETH,ETH/USDT --timeframe 1d --from 2025-01-01 --format parquet
defi-tool market-data download coingecko:aerodrome-finance --timeframe 4h --from 90d
defi-tool market-data download base:0x940181a94a35a4569e4529a3cdfb74e38fd98631/ETH --dry-run
```

```text
Market data · 1h candles · 2026-09-29 19:00 – 2026-10-29 18:00 UTC
Source: DefiLlama blended prices (no key) · coins found on CoinGecko

#  Pair      Coin                      Quote                     Sample  Candles  Filled  Thin  Jumps  Confidence  First candle
1  BTC/ETH   BTC (coingecko:bitcoin)   ETH (coingecko:ethereum)  5m          719       0     0      0        0.99  range start
2  ETH/USDT  ETH (coingecko:ethereum)  USDT (coingecko:tether)   5m          719       0     0      0        0.99  range start
```

- **Source:** [DefiLlama's coins API](https://defillama.com/docs/api), without a key: one USD price per coin, blended from many markets, kept about every 5 minutes for roughly the last 800 days (coarser further back, and 15 minutes or more for smaller coins). Each request returns up to 500 samples across its coins (250 each for a pair), so ranges are fetched in steps; `--dry-run` shows the coins found and the number of requests.
- **Pairs:** a single coin is priced in USD (`ETH` = `ETH/USD`). Two coins give a cross rate: the first coin's USD price divided by the second's at the same moment, each sample paired with the nearest quote sample within half a sample period, the way aggregators build crosses. `ETH/USDT` is therefore priced in actual USDT and shows a depeg; only `USD` itself is exactly 1.
- **Coins:** symbols are looked up with [CoinGecko's search](https://docs.coingecko.com/) (free, no key); among coins with exactly that symbol, the best market-cap rank wins, and the summary prints the ID used (`ETH (coingecko:ethereum)`). Pick another with `coingecko:<id>`, or a token with `chain:address` as DefiLlama names chains (`ethereum`, `base`, `arbitrum`, `bsc`, `solana`, ...); these are checked with DefiLlama, which also supplies the symbol.
- **Candles:** each period opens at its first sample, closes at its last, and takes the highest and lowest samples, so moves between samples are missed: highs and lows are approximate. The `samples` column says how many samples each candle used. There is no volume (DefiLlama has none). `--timeframe` `5m`, `15m`, `1h` (default), `4h`, `12h`, `1d`, `1w` (weeks start Monday 00:00 UTC).
- **Sampling:** `--sample auto` (default) uses the widest spacing that still gives about 12 samples per candle (5m for 1h candles, 15m for 4h, 1h for 12h and 1d, 4h for 1w). When fewer than 90% of periods get samples, as for coins DefiLlama keeps less often, it retries at the next coarser spacing that fits in a candle and keeps the fullest result. `--sample 5m|15m|1h|4h|1d` fixes the spacing.
- **Checks:** malformed and zero prices, duplicate samples, and samples outside the range are left out and counted. Periods without samples are filled with the previous close (`samples=0`, `filled=true`) unless `--fill none`; periods before the first sample are never filled. The summary reports **Thin** candles (under half the usual samples), **jumps** (closes over 50% from the previous close), DefiLlama's **confidence** score per coin (below 0.9 is flagged), a large share of filled candles, and few samples per candle.
- **Time, files and options** work as in `dex-data`: `--from` (default `30d`) and `--to` (default `now`), finished periods only unless `--include-partial`, `--format csv|json|jsonl|parquet`, `--out-dir` (default `./market-data`), a `.meta.json` beside each file (pair, coin keys, method, sample spacing, range, requests and every check), `--force`, `--json`. Columns: `time`, `timestamp`, `open`, `high`, `low`, `close`, `samples`, `filled`. Files are named like `BTC-ETH_1h_20260929-1900_20261029-1800.csv`.

## DEX ticker

`dex-ticker` shows a DEX pool's ticker, like an exchange app: price, 24h change, 24h high and low, 24h volume and liquidity. It prints one line and exits; `--watch` keeps it on screen and updates it live.

```bash
defi-tool dex-ticker WETH/USDC --chain base
defi-tool dex-ticker WETH/USDC --chain base --fee 0.05 --watch
defi-tool dex-ticker cbBTC/USDC --chain base --watch --interval 30s
defi-tool dex-ticker SOL/USDC --chain solana --dex raydium --protocol clmm --quote usd
defi-tool dex-ticker --pool 0xd0b53d9277642d899df5c87a3966a349a798f224 --chain base --json
defi-tool dex-ticker WETH/USDC --chain arb --watch --json --count 6 > ticks.jsonl
```

```text
$ defi-tool dex-ticker WETH/USDC --chain base --fee 0.05
WETH/USDC  2,322.12 USDC per WETH  24h -1.42%  H 2,390.19  L 2,291.41  Vol $12.9M  Liq $8.3M  Uniswap v3 0.05% on Base
```

- **Pool:** chosen as in `dex-data`: the deepest pool matching `--dex` (default `uniswap`), `--protocol` (default `v3`) and `--fee` on the `--chain` networks (default: saved chains), or `--pool <address>` with one `--chain`. The pair is written BASE/QUOTE, as exchanges do: `WETH/USDC` is priced in USDC per WETH.
- **Figures:** the price is the pool's own price, in the more money-like token (`--quote auto`), in USD (`--quote usd`), or in a token you name. 24h change, high and low come from the pool's 15-minute candles in the same unit: change against the last close at least 24 hours old, high and low over the day, widened by the live price between candle reads. Volume, liquidity and the 24h trade count are GeckoTerminal's, in USD.
- **`--watch`:** in a terminal, the ticker takes over the screen (alternate screen, cursor hidden) and redraws in place every `--interval` (default `10s`, at least `5s`). The price is green or red after a rise or fall, with an arrow and the move. `q` or Ctrl+C quits, restores the terminal, and leaves the last ticker line on screen. A failed update keeps the last figures on screen with the error and retries, waiting longer after repeated failures (up to a minute). Piped or redirected, `--watch` prints a line per update instead, or one JSON object per line with `--json`. `--count <n>` stops after n updates.
- **Source and limits:** GeckoTerminal's public API, without a key. It refreshes pool prices about every 10–60 seconds, so a faster `--interval` repeats prices. Each update takes one request; the 24h candles are refreshed once a minute (one more request). GeckoTerminal allows about 30 requests a minute, and rate limits are waited out.
- `--json` prints the pool, price unit and every figure unformatted, plus `updatedAt`. `--no-color` or `NO_COLOR` turns colors off; they are also off when the output is not a terminal.

## Configuration

`init` guides terminal users through chains, wallets, and optional RPC URLs; it does not ask for an API key. `defi-tool wallet add` is the easier way to save wallets: by name and network, editable later. Non-interactive callers can supply flags; remaining settings use defaults. Use real `0x` wallet addresses with 40 hexadecimal characters.

Configuration is stored in `~/.config/defi-tool/config.json` with mode `0600`; the default SQLite database is `~/.local/share/defi-tool/state.db`. Installations from before the rename used `~/.config/uniswap-tools/` and `~/.local/share/uniswap-tools/`; move those folders to the new names to keep your settings and cache. Rerunning `init` requires `--force` to replace existing settings. To keep existing settings, edit the file directly.

Use `--config /path/config.json` or `DEFI_TOOL_CONFIG` to choose a different configuration. Environment overrides include `DEFI_TOOL_DB_PATH`, `DEFI_TOOL_WALLETS` (comma-separated addresses) and `ALCHEMY_API_KEY` (for `wallet history`). These were `UNISWAP_CONFIG`, `UNISWAP_DB_PATH` and `UNISWAP_WALLETS` before the rename; `UNISWAP_API_URL` and `UNISWAP_API_KEY` keep their names because they configure the Uniswap GraphQL provider.

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

Run everything with `npm test`. `tests/chart-ui.test.ts` drives the HTML chart in headless Chrome or Chromium with real mouse and keyboard events (set `CHROME_PATH` to point at another build); it is skipped when no browser is installed. `DEFI_TOOL_DEXSCREENER_URL`, `DEFI_TOOL_REVERT_URL`, `DEFI_TOOL_PRICES_URL`, `DEFI_TOOL_ALCHEMY_URL`, `DEFI_TOOL_GECKOTERMINAL_URL` and `DEFI_TOOL_COINGECKO_URL` point DexScreener, Revert Finance, DefiLlama prices (also market-data), Alchemy, dex-data downloads and market-data coin lookups at test servers. Targeted provider checks: `node --import tsx --test tests/defillama-pools.test.ts tests/public-pools.test.ts tests/output.test.ts tests/rpc-positions.test.ts tests/analytics.test.ts tests/storage.test.ts`. CLI checks: `node --import tsx --test tests/config.test.ts tests/cli.test.ts tests/install.test.ts`. The project uses built-in `node:sqlite`, avoiding a native SQLite addon.

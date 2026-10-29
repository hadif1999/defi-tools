import type { LpPosition, Pool, PoolScore, PoolSort, PositionAnalysis } from './types.js';
import { invertPrice, rangePosition } from './positions-math.js';
import type { WalletBalance } from './providers/balances.js';
import { activityValue, swapResult, type HistoryResult } from './history.js';
import { ACTIVITY_KINDS, type ActivityKind, type Leg, type WalletActivity } from './types.js';
import type { CreatePlan, PlanTransaction } from './create-position.js';
import { CHAINS, type SavedWallet } from './types.js';
import type { GeckoPool } from './providers/geckoterminal.js';
import type { MarketDataset } from './market-data.js';

const MISSING = '—';

/** Compact dollar amounts as on the Uniswap Explore page: $492.84, $385.1K, $1.2B. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MISSING;
  if (value < 1_000) return `$${value.toFixed(2)}`;
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    // Round first so 999,960 shows as $1.0M rather than $1000.0K.
    if (Number((value / size).toFixed(1)) >= 1) return `$${(value / size).toFixed(1)}${suffix}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MISSING;
  return value > 0 && value < 0.01 ? '<0.01%' : `${value.toFixed(2)}%`;
}

export function formatFee(pool: Pool): string {
  return pool.feeTier !== undefined ? `${pool.feeTier / 10_000}%` : pool.feeLabel ?? MISSING;
}

export function volumeToTvl(pool: Pool): string {
  if (!pool.tvlUsd || pool.volume24hUsd === undefined) return MISSING;
  const ratio = pool.volume24hUsd / pool.tvlUsd;
  return ratio > 0 && ratio < 0.01 ? '<0.01' : ratio.toFixed(2);
}

/** Time since creation: 6h, 18d, 11mo, 4.5y. */
export function formatAge(createdAt: string | undefined, now = Date.now()): string {
  const created = createdAt === undefined ? NaN : Date.parse(createdAt);
  if (!Number.isFinite(created)) return MISSING;
  const hours = Math.max(0, now - created) / 3_600_000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30.44)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

/** Counts like 842, 15.4K, 1.2M. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MISSING;
  return value < 1_000 ? String(Math.round(value)) : formatUsd(value).slice(1);
}

export function poolName(pool: Pool): string {
  return pool.name ?? `${pool.token0.symbol}/${pool.token1.symbol}`;
}

/** GeckoTerminal and custom sources list Uniswap pools only and leave dex unset, so a pool without a dex is a Uniswap pool. */
export function poolDex(pool: Pool): string {
  return pool.dex ?? 'Uniswap';
}

/** Uniswap versions read as v2/v3/v4; Raydium pool types as CLMM/AMM. */
export function poolVersion(pool: Pool): string {
  return pool.protocol.startsWith('v') ? pool.protocol : pool.protocol.toUpperCase();
}

interface Column { header: string; align?: 'left' | 'right'; max?: number }

/** Plain aligned text table; no quotes or box characters, so it reads well and copies cleanly. */
export function renderTable(columns: Column[], rows: string[][]): string {
  const cells = rows.map((row) => row.map((cell, i) => {
    const max = columns[i]!.max;
    return max && cell.length > max ? `${cell.slice(0, max - 1)}…` : cell;
  }));
  const widths = columns.map((column, i) => Math.max(column.header.length, ...cells.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => columns[i]!.align === 'right' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(columns.map((column) => column.header)), line(widths.map((width) => '─'.repeat(width))), ...cells.map(line)].join('\n');
}

const sortLabels: Record<PoolSort, string> = { tvl: 'TVL', volume: '1D volume', apr: 'APR', 'vol-tvl': '1D vol/TVL' };

/** Explore-style pool listing. Chain is shown only when more than one network is listed. */
export function printPoolList(pools: Pool[], options: { json: boolean; sorts: readonly PoolSort[] }): void {
  if (options.json) return console.log(JSON.stringify({ schemaVersion: 1, data: pools }, null, 2));
  if (!pools.length) return console.log('No pools matched. Try another --chain or --protocol, or loosen --filter, --min-tvl, or --token.');
  const columns: Column[] = [
    { header: '#', align: 'right' }, { header: 'Pool', max: 28 }, { header: 'Chain' }, { header: 'DEX' },
    { header: 'Version' }, { header: 'Fee', align: 'right' }, { header: 'TVL', align: 'right' }, { header: '1D vol', align: 'right' },
    { header: '7D vol', align: 'right' }, { header: '1D vol/TVL', align: 'right' }, { header: 'APR', align: 'right' },
    { header: '1D txns', align: 'right' }, { header: 'Age', align: 'right' },
  ];
  console.log(`Pools sorted by ${options.sorts.map((sort) => sortLabels[sort]).join(', then ')}, highest first\n`);
  console.log(renderTable(columns, pools.map((pool, index) => [
    String(index + 1), poolName(pool), CHAINS[pool.chainId].name, poolDex(pool),
    poolVersion(pool), formatFee(pool), formatUsd(pool.tvlUsd), formatUsd(pool.volume24hUsd),
    formatUsd(pool.volume7dUsd), volumeToTvl(pool), formatPercent(pool.aprPct), formatCount(pool.txCount24h), formatAge(pool.createdAt),
  ])));
  const notes = [pools.some((pool) => poolDex(pool) === 'Uniswap')
    ? 'APR: last 24h of trading fees annualized against TVL, before the protocol fee (the Uniswap app shows the LP share, which can be lower).'
    : 'APR: last 24h of trading fees annualized against TVL, before the protocol fee (LPs receive a share of it).'];
  notes.push(pools.some((pool) => pool.source === 'defillama') ? '7D vol stands in for the app\'s 30D vol, which the free source does not provide.' : 'This source has no 7D volume; the default source (DefiLlama) does.');
  if (pools.some((pool) => pool.volume7dUsd === undefined || pool.aprPct === undefined)) notes.push('— means the source has no value for that pool.');
  if (pools.some((pool) => pool.dex === 'Aerodrome' && pool.aprPct === undefined)) notes.push('Aerodrome pays LPs in AERO rewards instead of trading fees, so many Aerodrome pools have no fee APR.');
  if (options.sorts.includes('apr') && pools.some((pool) => (pool.tvlUsd ?? 0) < 100_000)) notes.push('Tip: tiny pools can show extreme APRs; add --min-tvl 100k to skip them.');
  console.log(`\n${notes.join('\n')}`);
}

export function printPools(items: PoolScore[], json: boolean): void {
  if (json) return console.log(JSON.stringify({ schemaVersion: 1, data: items }, null, 2));
  if (!items.length) return console.log('No pools matched. Try another --chain or --protocol, a lower --min-tvl, or a different --token.');
  const columns: Column[] = [
    { header: '#', align: 'right' }, { header: 'Pool', max: 28 }, { header: 'Chain' }, { header: 'DEX' },
    { header: 'Version' }, { header: 'Fee', align: 'right' }, { header: 'TVL', align: 'right' }, { header: '1D vol', align: 'right' },
    { header: 'APR', align: 'right' }, { header: 'Score', align: 'right' }, { header: 'Confidence', align: 'right' },
  ];
  console.log(renderTable(columns, items.map(({ pool, score, confidence }, index) => [
    String(index + 1), poolName(pool), CHAINS[pool.chainId].name, poolDex(pool),
    poolVersion(pool), formatFee(pool), formatUsd(pool.tvlUsd), formatUsd(pool.volume24hUsd), formatPercent(pool.aprPct),
    score.toFixed(1), `${Math.round(confidence * 100)}%`,
  ])));
  console.log('\nWhy the top pools scored as they did (score 0–100 is a heuristic, not a yield forecast):');
  items.slice(0, 5).forEach(({ pool, reasons }, index) => console.log(`  ${index + 1}. ${poolName(pool)} ${poolVersion(pool)} ${formatFee(pool)}: ${reasons.join('; ')}`));
}

export function printPositions(items: PositionAnalysis[], json: boolean): void {
  if (json) return console.log(JSON.stringify({ schemaVersion: 1, data: items }, null, 2));
  if (!items.length) return console.log('No positions found for the selected wallets and networks. Check --wallet, --chain, and --protocol; run defi-tool positions --help for examples.');
  console.table(items.map((item) => ({ wallet: item.wallet, position: item.id, chain: CHAINS[item.chainId].name, protocol: item.protocol, status: item.status.replaceAll('_', ' '), tick: item.currentTick ?? 'n/a', valueUsd: item.valueUsd ?? 'n/a', reason: item.reason })));
}

/** "2026-10-29 07:09" in UTC. */
const formatTime = (iso: string | undefined): string => iso ? iso.slice(0, 16).replace('T', ' ') : MISSING;

/** Saved wallets with their balances; balances maps names to holdings, or the error that prevented reading them. */
export function printWallets(wallets: SavedWallet[], balances: Map<string, WalletBalance | Error> | undefined, json: boolean): void {
  if (json) {
    return console.log(JSON.stringify({ schemaVersion: 1, data: wallets.map((wallet) => {
      const balance = balances?.get(wallet.name);
      return { ...wallet, ...(balance instanceof Error ? { balanceError: balance.message } : balance ? { balance } : {}) };
    }) }, null, 2));
  }
  if (!wallets.length) return console.log('No saved wallets. Add one with defi-tool wallet add 0xYourWallet --chain eth --name my-wallet1.');
  const columns: Column[] = [
    { header: 'Name' }, { header: 'Chain' }, { header: 'Type' }, { header: 'Address' },
    ...(balances ? [{ header: 'Balance', align: 'right' as const }, { header: 'Holdings', max: 48 }] : []),
    { header: 'Added (UTC)' }, { header: 'Updated (UTC)' },
  ];
  console.log(renderTable(columns, wallets.map((wallet) => {
    const balance = balances?.get(wallet.name);
    const held = balance instanceof Error || !balance ? [] : balance.holdings.filter((holding) => holding.amount > 0);
    return [
      wallet.name, CHAINS[wallet.chainId].name, wallet.address.startsWith('0x') ? 'EVM' : 'Solana', wallet.address,
      ...(balances ? [balance instanceof Error ? MISSING : formatUsd(balance?.valueUsd), balance instanceof Error ? 'unavailable' : held.map((holding) => `${formatNumber(holding.amount)} ${holding.symbol}`).join(', ') || 'empty'] : []),
      formatTime(wallet.createdAt), wallet.updatedAt === wallet.createdAt ? MISSING : formatTime(wallet.updatedAt),
    ];
  })));
  const failed = wallets.filter((wallet) => balances?.get(wallet.name) instanceof Error);
  if (failed.length) console.error(`\nBalances unavailable: ${failed.map((wallet) => `${wallet.name} (${(balances!.get(wallet.name) as Error).message.split('\n')[0]})`).join('; ')}.`);
  if (balances) console.log('\nBalance: native coin plus well-known tokens (WETH, USDC, ... on Base and Arbitrum; SOL only on Solana), in USD at DefiLlama prices.');
}

/** Prices and amounts with a fixed number of decimals for their size, so columns line up: 2,313.09, 1.0042, 0.05634. */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MISSING;
  if (value === 0) return '0';
  const size = Math.abs(value);
  const options: Intl.NumberFormatOptions = size >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : size >= 1 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumSignificantDigits: 4, maximumSignificantDigits: 4 };
  return new Intl.NumberFormat('en-US', options).format(value);
}

/** -$1.06, +$2.10, $0.00. */
export function formatSignedUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return MISSING;
  if (Math.abs(value) < 0.005) return '$0.00';
  return `${value < 0 ? '-' : '+'}${formatUsd(Math.abs(value))}`;
}

/** Prices are shown in the more money-like token (stablecoin, then wrapped native coin): "USDC per WETH". */
function priceView(position: LpPosition) {
  const invert = invertPrice(position.token0.symbol, position.token1.symbol);
  const flip = (value: number | undefined) => value === undefined || !Number.isFinite(value) || value === 0 ? undefined : invert ? 1 / value : value;
  const [lower, upper] = invert ? [flip(position.priceUpper), flip(position.priceLower)] : [position.priceLower, position.priceUpper];
  const [base, quote] = invert ? [position.token1, position.token0] : [position.token0, position.token1];
  return { price: flip(position.price), exitPrice: flip(position.exitPrice), lower, upper, unit: `${quote.symbol} per ${base.symbol}` };
}

function rangeStatus(position: LpPosition): string {
  const view = priceView(position);
  if (view.price === undefined || view.lower === undefined || view.upper === undefined) return position.inRange === undefined ? MISSING : position.inRange ? '● In range' : '○ Out of range';
  const { side, distancePct } = rangePosition(view.price, view.lower, view.upper);
  return side === 'in' ? '● In range' : `${side === 'below' ? '▼ Below' : '▲ Above'} ${Math.abs(distancePct).toFixed(distancePct > -10 && distancePct < 10 ? 1 : 0)}%`;
}

const positionPool = (position: LpPosition) => `${position.token0.symbol}/${position.token1.symbol} ${position.feeTier === undefined ? '' : `${position.feeTier / 10_000}% `}${position.protocol}`;
const walletLabel = (position: LpPosition) => position.walletName ?? `${position.wallet.slice(0, 6)}…${position.wallet.slice(-4)}`;
const pnlCell = (position: LpPosition) => position.pnlUsd === undefined ? MISSING
  : `${formatSignedUsd(position.pnlUsd)}${position.depositedUsd ? ` (${position.pnlUsd >= 0 ? '+' : ''}${(position.pnlUsd / position.depositedUsd * 100).toFixed(1)}%)` : ''}`;
const day = (iso: string | undefined) => iso?.slice(0, 10) ?? MISSING;
const balance = (position: LpPosition) => position.amount0 === undefined || position.amount1 === undefined ? MISSING
  : [[position.amount0, position.token0.symbol], [position.amount1, position.token1.symbol]].filter(([amount]) => (amount as number) > 0).map(([amount, symbol]) => `${formatNumber(amount as number)} ${symbol}`).join(' + ') || '0';
const sum = (values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

export interface PositionTablesOptions {
  json: boolean;
  showActive: boolean;
  showPast: boolean;
  top: number;
  /** "ledger (0x902e…3f00) on Ethereum", one per wallet group, for the header. */
  scope: string[];
  source: string;
}

/** Open and closed positions as two tables, each limited to --top rows, with a summary line and notes on the figures. */
export function printPositionTables(active: LpPosition[], past: LpPosition[], options: PositionTablesOptions): void {
  const shownActive = options.showActive ? active.slice(0, options.top) : [];
  const shownPast = options.showPast ? past.slice(0, options.top) : [];
  if (options.json) return console.log(JSON.stringify({ schemaVersion: 1, data: { ...(options.showActive ? { active: shownActive } : {}), ...(options.showPast ? { past: shownPast } : {}) } }, null, 2));
  const all = [...active, ...past];
  let missing = false;
  // Columns with no value in any row (e.g. history columns for on-chain data) are left out.
  const print = (columns: Column[], rows: string[][]) => {
    const keep = columns.map((_, index) => rows.some((row) => row[index] !== MISSING && row[index] !== `${MISSING} – ${MISSING}`));
    const table = renderTable(columns.filter((_, index) => keep[index]), rows.map((row) => row.filter((_, index) => keep[index])));
    missing ||= table.includes(MISSING);
    console.log(table);
  };
  console.log(`Uniswap positions · ${options.scope.join(', ')}`);
  console.log(`Source: ${options.source} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  const history = all.filter((position) => position.historyAvailable);
  console.log(`Open: ${active.length} (value ${formatUsd(sum(active.map((position) => position.valueUsd)))}, unclaimed fees ${formatUsd(sum(active.map((position) => position.uncollectedFeesUsd)))}) · Closed: ${past.length}`
    + (history.length ? ` · Lifetime fees ${formatUsd(sum(history.map((position) => position.feesEarnedUsd)))} · PnL ${formatSignedUsd(sum(history.map((position) => position.pnlUsd)))}` : ''));
  const several = (rows: LpPosition[], key: (position: LpPosition) => string) => new Set(rows.map(key)).size > 1;
  const title = (name: string, shown: number, total: number, order: string) => `\n${name} (${total})${shown < total ? ` · showing ${shown} of ${total} (--top ${options.top})` : ''}${shown ? ` · ${order}` : ''}`;

  if (options.showActive) {
    console.log(title('Open positions', shownActive.length, active.length, 'largest value first'));
    if (!shownActive.length) console.log('  No open positions.');
    else {
      const wallet = several(shownActive, (position) => position.wallet);
      const chain = several(shownActive, (position) => String(position.chainId));
      const columns: Column[] = [{ header: '#', align: 'right' }, ...(wallet ? [{ header: 'Wallet', max: 16 }] : []), ...(chain ? [{ header: 'Chain' }] : []),
        { header: 'Pool', max: 32 }, { header: 'ID', align: 'right' }, { header: 'Price', align: 'right' }, { header: 'Range (min – max)' }, { header: 'Unit' }, { header: 'Status' },
        { header: 'Balance', max: 40 }, { header: 'Value', align: 'right' }, { header: 'Unclaimed', align: 'right' }, { header: 'Fees earned', align: 'right' },
        { header: 'Fee APR', align: 'right' }, { header: 'PnL', align: 'right' }, { header: 'Age', align: 'right' }];
      print(columns, shownActive.map((position, index) => {
        const view = priceView(position);
        return [String(index + 1), ...(wallet ? [walletLabel(position)] : []), ...(chain ? [CHAINS[position.chainId].name] : []),
          positionPool(position), `#${position.id}`, formatNumber(view.price), `${formatNumber(view.lower)} – ${formatNumber(view.upper)}`, view.unit, rangeStatus(position),
          balance(position), formatUsd(position.valueUsd), formatUsd(position.uncollectedFeesUsd), formatUsd(position.feesEarnedUsd),
          formatPercent(position.feeAprPct), pnlCell(position), formatAge(position.openedAt)];
      }));
    }
  }

  if (options.showPast) {
    console.log(title('Closed positions', shownPast.length, past.length, 'most recently closed first'));
    if (!shownPast.length) console.log('  No closed positions.');
    else {
      const wallet = several(shownPast, (position) => position.wallet);
      const chain = several(shownPast, (position) => String(position.chainId));
      const unclaimed = shownPast.some((position) => (position.uncollectedFeesUsd ?? 0) >= 0.01);
      const columns: Column[] = [{ header: '#', align: 'right' }, ...(wallet ? [{ header: 'Wallet', max: 16 }] : []), ...(chain ? [{ header: 'Chain' }] : []),
        { header: 'Pool', max: 32 }, { header: 'ID', align: 'right' }, { header: 'Range (min – max)' }, { header: 'Exit price', align: 'right' }, { header: 'Price now', align: 'right' }, { header: 'Unit' },
        { header: 'Deposited', align: 'right' }, { header: 'Withdrawn', align: 'right' }, { header: 'Fees earned', align: 'right' }, ...(unclaimed ? [{ header: 'Unclaimed', align: 'right' as const }] : []), { header: 'Gas', align: 'right' },
        { header: 'Fee APR', align: 'right' }, { header: 'PnL', align: 'right' }, { header: 'IL', align: 'right' },
        { header: 'Opened' }, { header: 'Closed' }, { header: 'Held', align: 'right' }];
      print(columns, shownPast.map((position, index) => {
        const view = priceView(position);
        return [String(index + 1), ...(wallet ? [walletLabel(position)] : []), ...(chain ? [CHAINS[position.chainId].name] : []),
          positionPool(position), `#${position.id}`, `${formatNumber(view.lower)} – ${formatNumber(view.upper)}`, formatNumber(view.exitPrice), formatNumber(view.price), view.unit,
          formatUsd(position.depositedUsd), formatUsd(position.withdrawnUsd), formatUsd(position.feesEarnedUsd), ...(unclaimed ? [formatUsd(position.uncollectedFeesUsd)] : []), formatUsd(position.gasUsd),
          formatPercent(position.feeAprPct), pnlCell(position), formatSignedUsd(position.ilUsd),
          day(position.openedAt), day(position.closedAt), position.openedAt && position.closedAt ? formatAge(position.openedAt, Date.parse(position.closedAt)) : MISSING];
      }));
    }
  }

  const shown = [...shownActive, ...shownPast];
  if (!shown.length) return;
  const notes = ['Prices are in the Unit column: the quote is a stablecoin or the wrapped native coin when the pair has one.'];
  if (shown.some((position) => position.historyAvailable)) notes.push('Fees earned: collected plus unclaimed, over the position\'s life. Fee APR: fees earned ÷ deposits, annualized over the time held.',
    'PnL: value now + withdrawals + fees − deposits − gas, each in USD when it happened. IL: impermanent loss, fees excluded: what the position returned minus the deposited tokens, both valued at the exit price (today\'s for open positions).');
  if (shown.some((position) => !position.historyAvailable)) notes.push('On-chain data only: deposits, withdrawals, collected fees, PnL and dates are unknown, and closed positions are the NFTs the wallet still holds.');
  if (shownPast.length) notes.push(shownPast.some((position) => position.exitPrice !== undefined) ? 'Exit price: pool price at the last withdrawal. Price now: current pool price.' : 'Price now: current pool price.');
  if (missing) notes.push('— means the source has no value for that position.');
  console.log(`\n${notes.join('\n')}`);
}

export type Signer = 'mm' | 'raw';

/** The command that signs and sends one planned transaction with the MetaMask agent wallet CLI. */
export function mmCommand(chainId: number, transaction: PlanTransaction): string {
  const payload = JSON.stringify({ to: transaction.to, data: transaction.data, value: `0x${BigInt(transaction.value).toString(16)}` });
  return `mm wallet send-transaction --chain-id ${chainId} --payload '${payload}' --intent '${transaction.description.replaceAll("'", '')}'`;
}

/** A planned position: what will be deposited where, what to check, and the transactions to sign in order. */
export function printCreatePlan(plan: CreatePlan, options: { json: boolean; signer: Signer }): void {
  const commands = options.signer === 'mm' ? plan.transactions.map((transaction) => mmCommand(plan.chainId, transaction)) : undefined;
  if (options.json) return console.log(JSON.stringify({ schemaVersion: 1, data: { ...plan, commands } }, null, 2));
  const { token0, token1, range, deposit } = plan;
  const fee = `${plan.pool.feeTier / 10_000}%`;
  const amount = (value: string, symbol: string) => `${formatNumber(Number(value))} ${symbol}`;
  const usd = (value: string, price: number | undefined) => price === undefined ? '' : ` (${formatUsd(Number(value) * price)})`;
  const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  const rows: Array<[string, string]> = [
    ['Pool', `${token0.symbol}/${token1.symbol} ${fee} v3 · ${plan.pool.address}${plan.pool.tvlUsd !== undefined ? ` · TVL ${formatUsd(plan.pool.tvlUsd)}` : ''}`],
    ['Price now', `${formatNumber(plan.price)} ${plan.unit}`],
    ['Range', range.fullRange ? 'Full range (every price)' : `${formatNumber(range.lower)} – ${formatNumber(range.upper)} ${plan.unit} (${pct(range.lowerPct)} / ${pct(range.upperPct)}; ticks ${range.tickLower} to ${range.tickUpper}, spacing ${plan.pool.tickSpacing})`],
    ['Deposit', `${([[deposit.amount0, token0], [deposit.amount1, token1]] as const).map(([value, info], side) => [value, info, deposit.nativeSide === side] as const)
      .filter(([value]) => Number(value) > 0).map(([value, info, native]) => `${amount(value, native ? 'ETH' : info.symbol)}${usd(value, info.priceUsd)}`).join(' + ') || '0'}${deposit.valueUsd !== undefined ? ` = ${formatUsd(deposit.valueUsd)}` : ''}`],
    ['Minimum', `${amount(deposit.min0, token0.symbol)}, ${amount(deposit.min1, token1.symbol)} (the mint reverts if the price moves further before it lands)`],
    ['Wallet', `${plan.wallet}: ${amount(plan.wallets.balance0, token0.symbol)}, ${amount(plan.wallets.balance1, token1.symbol)}, ${amount(plan.wallets.native, 'ETH')}`],
  ];
  if (plan.volatility) {
    const days = (value: number | undefined) => value === undefined ? undefined : value < 1 ? '<1 day' : `~${Math.round(value)} days`;
    const reach = [days(plan.volatility.daysToLower) && `lower limit ${days(plan.volatility.daysToLower)}`, days(plan.volatility.daysToUpper) && `upper limit ${days(plan.volatility.daysToUpper)}`].filter(Boolean).join(', ');
    rows.push(['Volatility', `±${plan.volatility.dailyPct.toFixed(1)}% a day over ${plan.volatility.days} days${reach ? `; a typical move reaches the ${reach}` : ''}`]);
  }
  const simulation = { passed: `passed${plan.simulation.tokenId ? ` (would mint #${plan.simulation.tokenId}` : ''}${plan.simulation.gas ? `, ~${Number(plan.simulation.gas).toLocaleString('en-US')} gas` : ''}${plan.simulation.tokenId ? ')' : ''}`,
    failed: `failed: ${plan.simulation.message}`, 'after-approvals': 'after the approvals' }[plan.simulation.status];
  rows.push(['Simulation', simulation], ['Deadline', `${plan.deadline.slice(0, 16).replace('T', ' ')} UTC (the mint reverts after this)`]);
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(`New Uniswap v3 position · ${CHAINS[plan.chainId].name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`);
  console.log(rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n'));
  if (plan.warnings.length) console.log(`\nWarnings:\n${plan.warnings.map((warning) => `  ! ${warning}`).join('\n')}`);
  console.log(`\n${plan.ready ? 'Transactions' : 'Transactions (not ready: fix the warnings above first)'}, in order, from ${plan.wallet}:`);
  plan.transactions.forEach((transaction, index) => {
    console.log(`\n${index + 1}. ${transaction.description}${transaction.value !== '0' ? ` (sends ${formatNumber(Number(transaction.value) / 1e18)} ETH)` : ''}`);
    if (commands) console.log(`   ${commands[index]}`);
    else console.log(`   to: ${transaction.to}\n   value: ${transaction.value}\n   data: ${transaction.data}`);
  });
  const notes = ['Nothing has been signed or sent. Sign each transaction with the wallet above, in order, waiting for each to confirm.'];
  if (plan.simulation.status === 'after-approvals') notes.push('After the approvals confirm, run this command again: it rebuilds the mint at the latest price and simulates it.');
  if (commands) notes.push('Check any step with: mm decode --payload <data>. --signer raw prints to/value/data for any other wallet.');
  console.log(`\n${notes.join('\n')}`);
}

const kindLabels: Record<ActivityKind, string> = {
  swap: 'Swap', 'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'collect-fees': 'Collect fees',
  send: 'Send', receive: 'Receive', wrap: 'Wrap', unwrap: 'Unwrap', other: 'Other',
};
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const legsText = (legs: Leg[]) => legs.map((leg) => `${formatNumber(leg.amount)} ${leg.symbol}`).join(' + ') || '—';

/** One line saying what moved: "0.0100 WETH → 23.1000 USDC (−$0.08)", "WETH/USDC 0.05% v3 #57 → 0.0323 WETH". */
export function activityDetails(activity: WalletActivity): string {
  const position = activity.pool ? `${activity.pool}${activity.positionId ? ` #${activity.positionId}` : ''}` : '';
  const others = (activity.counterparty ?? '').split(', ').filter(Boolean).map(shortAddress).join(', ');
  switch (activity.kind) {
    case 'swap': case 'wrap': case 'unwrap': case 'other': {
      const result = swapResult(activity);
      return `${legsText(activity.sent)} → ${legsText(activity.received)}${result !== undefined && Math.abs(result) >= 0.005 ? ` (${formatSignedUsd(result)})` : ''}`;
    }
    case 'add-liquidity': return `${legsText(activity.sent)} → ${position}`;
    case 'remove-liquidity': return `${position} → ${legsText(activity.received)}${activity.fees?.length ? ` + fees ${legsText(activity.fees)}` : ''}`;
    case 'collect-fees': return `${position} → ${legsText(activity.received)}`;
    case 'send': return `${legsText(activity.sent)} → ${others}`;
    case 'receive': return `${legsText(activity.received)} ← ${others}`;
  }
}

/** Wallet history: a summary of the period, then one row per transaction, newest first. */
export function printHistory(result: HistoryResult, options: { json: boolean; title: string; days: number }): void {
  if (options.json) return console.log(JSON.stringify({ schemaVersion: 1, data: { total: result.total, spamHidden: result.spamHidden, summary: result.summary, sources: result.sources, activities: result.activities } }, null, 2));
  const { activities, summary } = result;
  console.log(`${options.title} · last ${options.days} day${options.days === 1 ? '' : 's'}`);
  console.log(`Source: ${result.sources.join(' and ') || 'none'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (!activities.length) {
    console.log('\nNo transactions in this period. Try a longer --days, another --chain, or fewer --type filters.');
  } else {
    const counts = ACTIVITY_KINDS.filter((kind) => summary.byKind[kind]).map((kind) => `${summary.byKind[kind]} ${kindLabels[kind].toLowerCase()}`).join(', ');
    const totals = [
      summary.swapVolumeUsd ? `swapped ${formatUsd(summary.swapVolumeUsd)} (cost ${formatUsd(Math.max(0, summary.swapCostUsd))})` : '',
      summary.addedUsd ? `added ${formatUsd(summary.addedUsd)}` : '', summary.removedUsd ? `removed ${formatUsd(summary.removedUsd)}` : '',
      summary.feesCollectedUsd ? `fees collected ${formatUsd(summary.feesCollectedUsd)}` : '', `gas ${formatUsd(summary.gasUsd)}`,
    ].filter(Boolean).join(' · ');
    console.log(`${result.total > activities.length ? `Showing ${activities.length} of ${result.total} transactions` : `${activities.length} transaction${activities.length === 1 ? '' : 's'}`}: ${counts}`);
    console.log(`${totals}\n`);
    const chain = new Set(activities.map((activity) => activity.chainId)).size > 1;
    const columns: Column[] = [
      { header: '#', align: 'right' }, { header: 'Time (UTC)' }, ...(chain ? [{ header: 'Chain' }] : []), { header: 'Type' },
      { header: 'Details', max: 96 }, { header: 'Value', align: 'right' }, { header: 'Gas', align: 'right' }, { header: 'Tx' },
    ];
    console.log(renderTable(columns, activities.map((activity, index) => [
      String(index + 1), formatTime(activity.timestamp), ...(chain ? [CHAINS[activity.chainId].name] : []), kindLabels[activity.kind] + (activity.spam ? ' (spam?)' : ''),
      activityDetails(activity), formatUsd(activityValue(activity)), activity.gasUsd !== undefined ? formatUsd(activity.gasUsd) : activity.gasNative === undefined ? MISSING : `${formatNumber(activity.gasNative)} ${CHAINS[activity.chainId].native}`,
      shortAddress(activity.hash),
    ])));
  }
  const notes = ['Values are in USD at the time of each transaction. Gas is shown for transactions this wallet sent; swap cost = value sent − value received.'];
  if (result.spamHidden) notes.push(`${result.spamHidden} likely spam airdrop(s) of unknown, unpriced tokens hidden; --all shows them.`);
  if (!result.sources.includes('Alchemy')) notes.push('Swaps and transfers need a free Alchemy key: export ALCHEMY_API_KEY=... (https://dashboard.alchemy.com). Liquidity activity needs no key.');
  else notes.push('Approvals and transactions that moved no tokens are not listed. --json gives full hashes and explorer links.');
  console.log(`\n${notes.join('\n')}`);
}

/** One pair or pool of a market-data download: what was used, and what was written or went wrong. */
export interface MarketDownload {
  label: string;
  pool?: GeckoPool;
  alternatives: GeckoPool[];
  dataset?: Omit<MarketDataset, 'candles' | 'validation' | 'requests' | 'downloadedAt'> & Partial<MarketDataset>;
  plannedRequests?: number;
  files?: string[];
  error?: string;
}

const geckoPoolLabel = (pool: GeckoPool) => `${pool.name}${pool.version ? ` ${pool.version}` : ''} ${pool.dex ? pool.dex[0]!.toUpperCase() + pool.dex.slice(1) : pool.dexId}`;

/** The market-data summary: one row per pair with the pool used, candle counts and checks, then files and notes. */
export function printMarketDownloads(results: MarketDownload[], options: { json: boolean; dryRun: boolean; timeframe: string; from: number; to: number }): void {
  if (options.json) {
    console.log(JSON.stringify({ data: results.map((result) => ({ pair: result.label, ...(result.dataset ?? {}), plannedRequests: result.plannedRequests, files: result.files, alternatives: result.alternatives.map((pool) => ({ address: pool.address, name: pool.name, dexId: pool.dexId, tvlUsd: pool.tvlUsd, chainId: pool.chainId })), error: result.error })) }, null, 2));
    return;
  }
  const exact = (value: number | undefined) => value === undefined ? MISSING : value.toLocaleString('en-US');
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Market data · ${options.timeframe} candles · ${day(options.from)} – ${day(options.to)} UTC${options.dryRun ? ' · dry run' : ''}`);
  console.log('Source: GeckoTerminal public API (no key)\n');
  const done = results.filter((result) => result.pool && !result.error);
  if (done.length) {
    const columns = [{ header: '#', align: 'right' as const }, { header: 'Pair' }, { header: 'Chain' }, { header: 'Pool' }, { header: 'TVL', align: 'right' as const }, { header: 'Unit' },
      ...(options.dryRun ? [{ header: 'Requests', align: 'right' as const }] : [{ header: 'Candles', align: 'right' as const }, { header: 'Filled', align: 'right' as const }, { header: 'Dropped', align: 'right' as const }, { header: 'Jumps', align: 'right' as const }, { header: 'First candle' }])];
    console.log(renderTable(columns, done.map((result, index) => {
      const validation = result.dataset!.validation;
      const dropped = validation ? Object.values(validation.dropped).reduce((sum, count) => sum + count, 0) : 0;
      const first = validation && result.dataset!.candles ? validation.leadingEmpty === 0 ? 'range start' : `+${formatCount(validation.leadingEmpty)} periods` : MISSING;
      return [String(index + 1), result.label, CHAINS[result.pool!.chainId].name, geckoPoolLabel(result.pool!), formatUsd(result.pool!.tvlUsd), result.dataset!.priceUnit,
        ...(options.dryRun ? [String(result.plannedRequests)] : [exact(result.dataset!.candles), exact(validation?.filled), exact(dropped), exact(validation?.jumps), result.dataset!.candles ? first : 'no trades']),
      ];
    })));
    console.log('');
    for (const result of done) {
      console.log(`${result.label}: ${options.dryRun ? 'would write ' : ''}${result.files!.join(', ')}`);
      const validation = result.dataset!.validation;
      if (validation) {
        const reasons = Object.entries(validation.dropped).map(([reason, count]) => `${count} ${reason}`);
        if (validation.conflicts) reasons.push(`${validation.conflicts} repeated periods with different values (first kept)`);
        if (reasons.length) console.log(`  Dropped: ${reasons.join(', ')}.`);
        if (validation.jumps) console.log(`  ${validation.jumps} candle(s) closed more than 50% away from the previous close; check them before relying on the data.`);
        if (validation.leadingEmpty && result.dataset!.candles) console.log(`  No trades in the first ${formatCount(validation.leadingEmpty)} periods (pool created ${result.pool!.createdAt?.slice(0, 10) ?? 'at an unknown date'}); the data starts at its first trade.`);
        if (!result.dataset!.candles) console.log('  No trades in this range: the file has no candles.');
        if (validation.missing && result.dataset!.fill === 'none') console.log(`  ${formatCount(validation.missing)} periods without trades are left out (--fill none).`);
      }
      if (result.alternatives.length) console.log(`  Other pools: ${result.alternatives.map((pool) => `${geckoPoolLabel(pool)} on ${CHAINS[pool.chainId].name} (${formatUsd(pool.tvlUsd)}, ${pool.address.slice(0, 10)}…)`).join('; ')}. Pick one with --fee, --protocol or --pool.`);
    }
  }
  for (const result of results.filter((item) => item.error)) console.error(`${result.label}: ${result.error}`);
}

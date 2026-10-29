import { z } from 'zod';
import type { EvmChainId, Leg, LpPosition, Protocol, WalletActivity } from '../types.js';
import { annualize } from '../positions-math.js';
import { finite, getJson } from './http.js';

// Revert Finance's public positions API (no key). It indexes Uniswap position NFTs on every network, including
// closed ones, with deposits, withdrawals, fees and PnL; Uniswap's own APIs do not list positions.
export const REVERT_URL = 'https://api.revert.finance';
const networks: Record<string, EvmChainId> = { mainnet: 1, ethereum: 1, optimism: 10, bsc: 56, polygon: 137, base: 8453, arbitrum: 42161 };
const exchanges: Record<Protocol, string> = { v3: 'uniswapv3', v4: 'uniswapv4' };
const MAX_PAGES = 20;

const number = z.unknown().transform(finite);
// Each cash flow carries token amounts and the tokens' USD prices at that time, so deposits, withdrawals and fees are valued
// when they happened. (deposits_value and withdrawals_value use today's prices, for Revert's own comparisons.)
const usdPrice = z.object({ usd: number }).partial().optional();
const cashFlowSchema = z.object({
  type: z.string(), timestamp: number, price: number, amount0: number, amount1: number, amount_usd: number,
  /** Gas flows: the fee in the native coin, negative. */
  amount: number, tx_hash: z.string().optional(),
  prices: z.object({ token0: usdPrice, token1: usdPrice }).partial().optional(),
});
const tokenSchema = z.object({ symbol: z.string().optional(), decimals: number, price: number });
const positionSchema = z.object({
  nft_id: z.union([z.string(), z.number()]).transform(String),
  network: z.string(),
  pool: z.string().optional(),
  owner: z.string().optional(),
  token0: z.string(),
  token1: z.string(),
  tokens: z.record(tokenSchema).default({}),
  fee_tier: number,
  tick_lower: number,
  tick_upper: number,
  pool_tick: number,
  price_lower: number,
  price_upper: number,
  pool_price: number,
  liquidity: z.union([z.string(), z.number()]).transform(String).default('0'),
  exited: z.boolean().default(false),
  in_range: z.boolean().optional(),
  current_amount0: number,
  current_amount1: number,
  underlying_value: number,
  uncollected_fees0: number,
  uncollected_fees1: number,
  fees_value: number,
  deposits_value: number,
  withdrawals_value: number,
  first_mint_ts: number,
  performance: z.object({ usd: z.object({ pnl: number }).partial().optional(), hodl: z.object({ il: number }).partial().optional() }).partial().optional(),
  cash_flows: z.array(z.unknown()).default([]),
});
type Row = z.infer<typeof positionSchema>;

export interface RevertOptions { endpoint?: string; fetcher?: typeof fetch; timeoutMs?: number; retryDelayMs?: number; now?: () => number }

export class RevertClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: RevertOptions = {}) { this.fetcher = options.fetcher ?? fetch; }

  /** Every Uniswap v3 and v4 position the address has held, open and closed, on the given networks. */
  async listPositions(address: string, chains: readonly EvmChainId[]): Promise<LpPosition[]> {
    const lists = await Promise.all((Object.keys(exchanges) as Protocol[]).map(async (protocol) => (await this.pages(address, protocol)).map((row) => [protocol, row] as const)));
    return lists.flat().flatMap(([protocol, row]) => {
      const chainId = networks[row.network.toLowerCase()];
      return chainId !== undefined && chains.includes(chainId) ? [this.toPosition(row, protocol, chainId, address)] : [];
    });
  }

  /**
   * Liquidity activity for wallet history: one entry per transaction of each position (adds, removes, fee collects),
   * with token amounts valued at the time and the gas the wallet paid. Withdrawing and collecting in one transaction
   * is one "remove-liquidity" entry carrying the fees separately.
   */
  async activity(address: string, chains: readonly EvmChainId[]): Promise<WalletActivity[]> {
    const lists = await Promise.all((Object.keys(exchanges) as Protocol[]).map(async (protocol) => (await this.pages(address, protocol)).map((row) => [protocol, row] as const)));
    return lists.flat().flatMap(([protocol, row]) => {
      const chainId = networks[row.network.toLowerCase()];
      if (chainId === undefined || !chains.includes(chainId)) return [];
      const symbol = (token: string) => (row.tokens[token] ?? row.tokens[token.toLowerCase()])?.symbol ?? `${token.slice(0, 6)}…`;
      const pool = `${symbol(row.token0)}/${symbol(row.token1)}${row.fee_tier !== undefined ? ` ${row.fee_tier / 10_000}%` : ''} ${protocol}`;
      const flows = row.cash_flows.flatMap((flow) => { const parsed = cashFlowSchema.safeParse(flow); return parsed.success && parsed.data.tx_hash ? [parsed.data] : []; });
      const legs = (flow: (typeof flows)[number]): Leg[] => ([[row.token0, flow.amount0, flow.prices?.token0?.usd], [row.token1, flow.amount1, flow.prices?.token1?.usd]] as const)
        .filter(([, amount]) => amount !== undefined && amount !== 0)
        .map(([token, amount, price]) => ({ symbol: symbol(token), address: token.toLowerCase(), amount: Math.abs(amount!), valueUsd: price === undefined ? undefined : Math.abs(amount!) * price }));
      const byHash = new Map<string, typeof flows>();
      for (const flow of flows) byHash.set(flow.tx_hash!, [...(byHash.get(flow.tx_hash!) ?? []), flow]);
      return [...byHash].flatMap(([hash, group]): WalletActivity[] => {
        const of = (type: string) => group.filter((flow) => flow.type === type).flatMap(legs);
        const [deposits, withdrawals, fees] = [of('deposits'), of('withdrawals'), of('claimed-fees')];
        const gas = group.filter((flow) => flow.type === 'gas-costs');
        const kind = deposits.length ? 'add-liquidity' : withdrawals.length ? 'remove-liquidity' : fees.length ? 'collect-fees' : undefined;
        if (!kind) return [];
        const timestamp = Math.max(...group.map((flow) => flow.timestamp ?? 0));
        return [{
          chainId, hash, timestamp: new Date(timestamp * 1000).toISOString(), kind, positionId: row.nft_id, pool,
          sent: deposits, received: kind === 'collect-fees' ? fees : withdrawals, fees: kind === 'remove-liquidity' && fees.length ? fees : undefined,
          gasNative: gas.length ? gas.reduce((total, flow) => total + Math.abs(flow.amount ?? 0), 0) : undefined,
          gasUsd: gas.length ? gas.reduce((total, flow) => total + Math.abs(flow.amount_usd ?? 0), 0) : undefined,
          source: 'revert',
        }];
      });
    });
  }

  private async pages(address: string, protocol: Protocol): Promise<Row[]> {
    const base = `${(this.options.endpoint ?? REVERT_URL).replace(/\/$/, '')}/v1/positions/${exchanges[protocol]}/account/${address.toLowerCase()}?active=false`;
    const rows: Row[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(this.fetcher, cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base, 'Revert Finance', this.options.timeoutMs ?? 30_000, this.options.retryDelayMs) as { success?: unknown; data?: unknown; pagination?: { next_cursor?: unknown } } | null;
      if (!body || body.success === false || !Array.isArray(body.data)) throw new Error('Revert Finance returned an unexpected response (no position list).');
      // Skip a malformed position rather than failing the whole wallet.
      for (const item of body.data) { const parsed = positionSchema.safeParse(item); if (parsed.success) rows.push(parsed.data); }
      const next = body.pagination?.next_cursor;
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }
    return rows;
  }

  private toPosition(row: Row, protocol: Protocol, chainId: EvmChainId, wallet: string): LpPosition {
    const token = (address: string) => {
      const info = row.tokens[address] ?? row.tokens[address.toLowerCase()];
      return { address, symbol: info?.symbol ?? `${address.slice(0, 6)}…`, decimals: info?.decimals, priceUsd: info?.price };
    };
    const token0 = token(row.token0);
    const token1 = token(row.token1);
    const flows = row.cash_flows.flatMap((flow) => { const parsed = cashFlowSchema.safeParse(flow); return parsed.success ? [parsed.data] : []; });
    const active = !row.exited && row.liquidity !== '0';
    // A closed position ends with its last withdrawal or fee claim; Revert's age counts to now, so it is not used for them.
    const exit = active ? undefined : flows.filter((flow) => flow.type === 'withdrawals' && flow.price !== undefined).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
    const closedTs = active ? undefined : Math.max(...flows.filter((flow) => flow.type === 'withdrawals' || flow.type === 'claimed-fees').map((flow) => flow.timestamp ?? 0), 0) || undefined;
    const now = (this.options.now ?? Date.now)() / 1000;
    const days = row.first_mint_ts === undefined ? 0 : ((closedTs ?? now) - row.first_mint_ts) / 86_400;
    // Sum of |amount0| × price0 + |amount1| × price1 over flows of one type, at their own prices; undefined when a price is missing.
    const valued = (type: string) => {
      let total = 0;
      for (const flow of flows.filter((item) => item.type === type)) {
        const [price0, price1] = [flow.prices?.token0?.usd, flow.prices?.token1?.usd];
        if (price0 === undefined || price1 === undefined) return undefined;
        total += Math.abs(flow.amount0 ?? 0) * price0 + Math.abs(flow.amount1 ?? 0) * price1;
      }
      return total;
    };
    const deposited = valued('deposits') ?? row.deposits_value;
    const withdrawn = valued('withdrawals') ?? row.withdrawals_value;
    const gas = flows.filter((flow) => flow.type === 'gas-costs').reduce((total, flow) => total + Math.abs(flow.amount_usd ?? 0), 0);
    const ratio = (value: number | undefined) => value === undefined || !deposited ? undefined : value / deposited;
    const uncollected = row.uncollected_fees0 !== undefined && row.uncollected_fees1 !== undefined && token0.priceUsd !== undefined && token1.priceUsd !== undefined
      ? row.uncollected_fees0 * token0.priceUsd + row.uncollected_fees1 * token1.priceUsd : undefined;
    const claimed = valued('claimed-fees');
    const fees = claimed !== undefined && uncollected !== undefined ? claimed + uncollected : row.fees_value;
    // PnL in USD: what came out (withdrawals, fees, value still in the position) minus what went in and gas.
    const pnl = deposited !== undefined && withdrawn !== undefined && fees !== undefined && row.underlying_value !== undefined
      ? row.underlying_value + withdrawn + fees - deposited - gas : row.performance?.usd?.pnl;
    // Impermanent loss: the tokens the position gave back (withdrawals plus what it still holds) minus the tokens deposited,
    // valued at one set of prices: at the last withdrawal for a closed position (later moves happen to tokens you hold anyway),
    // today's for an open one. Fees are not included. Revert's performance.usd.il is withdrawals minus deposits at different
    // times, which also counts the market's move, so it is used only when amounts or prices are missing.
    const net = (side: 'amount0' | 'amount1', current: number | undefined) => flows.filter((flow) => flow.type === 'deposits' || flow.type === 'withdrawals')
      .reduce((total, flow) => total + (flow[side] ?? 0), current ?? 0);
    const [ilPrice0, ilPrice1] = active ? [token0.priceUsd, token1.priceUsd] : [exit?.prices?.token0?.usd, exit?.prices?.token1?.usd];
    const il = ilPrice0 !== undefined && ilPrice1 !== undefined && flows.some((flow) => flow.type === 'deposits')
      ? net('amount0', active ? row.current_amount0 : 0) * ilPrice0 + net('amount1', active ? row.current_amount1 : 0) * ilPrice1
      : row.performance?.hodl?.il;
    const iso = (seconds: number | undefined) => seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
    return {
      id: row.nft_id, chainId, dex: 'Uniswap', protocol, wallet: (row.owner ?? wallet).toLowerCase(), pool: row.pool,
      token0, token1, feeTier: row.fee_tier,
      tickLower: row.tick_lower ?? 0, tickUpper: row.tick_upper ?? 0, currentTick: row.pool_tick,
      priceLower: row.price_lower, priceUpper: row.price_upper, price: row.pool_price, exitPrice: exit?.price,
      liquidity: row.liquidity, active,
      inRange: row.tick_lower !== undefined && row.tick_upper !== undefined && row.pool_tick !== undefined ? row.pool_tick >= row.tick_lower && row.pool_tick < row.tick_upper : row.in_range,
      amount0: row.current_amount0, amount1: row.current_amount1, valueUsd: row.underlying_value,
      uncollectedFees0: row.uncollected_fees0, uncollectedFees1: row.uncollected_fees1, uncollectedFeesUsd: uncollected,
      feesEarnedUsd: fees, depositedUsd: deposited, withdrawnUsd: withdrawn, gasUsd: gas,
      pnlUsd: pnl, ilUsd: il,
      feeAprPct: annualize(ratio(fees), days), totalAprPct: annualize(ratio(pnl), days),
      openedAt: iso(row.first_mint_ts), closedAt: iso(closedTs),
      source: 'revert', historyAvailable: true,
    };
  }
}

import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { CHAINS, type EvmChainId } from './types.js';
import type { RpcProvider } from './providers/rpc.js';
import { V3_FACTORIES, V3_POSITIONS } from './providers/deployments.js';
import { dailyPrices, usdPrices } from './providers/prices.js';
import { knownSymbols, tokenAddress } from './providers/tokens.js';
import { invertPrice } from './positions-math.js';
import { amountsForLiquidity, liquidityForAmounts, minimumAmounts, sqrtRatioAtTick, tickAtOrBelowPrice, usableTickBounds } from './v3-math.js';

/**
 * Plans a new Uniswap v3 position: reads the pool and the wallet on-chain, works out ticks, amounts and slippage
 * minimums exactly, and builds the approve and mint transactions for the wallet to sign. Nothing is signed or sent.
 */

const FEE_TIERS = [100, 500, 3000, 10_000] as const;
const MAX_UINT256 = 2n ** 256n - 1n;
/** A token amount for messages, to 6 significant digits; transactions always carry the exact amount. */
const show = (raw: bigint, decimals: number): string => Number(Number(formatUnits(raw, decimals)).toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 18 });
/** Native coin kept for gas when a position is paid in ETH: L2 transactions cost a small fraction of this. */
const GAS_RESERVE = 5n * 10n ** 14n;

const erc20Abi = parseAbi([
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const poolAbi = parseAbi([
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)',
]);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const managerAbi = parseAbi([
  'function WETH9() view returns (address)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function multicall(bytes[]) payable returns (bytes[])',
  'function refundETH() payable',
]);

/** A range limit: a percentage from the current price (-15% or +10%), or a price in the quote unit shown (2100). */
export type Limit = { kind: 'percent'; value: number } | { kind: 'price'; value: number };
/** How much to deposit: a USD total, a fixed amount of one token (the other follows from the range), or all the wallet can fund. */
export type AmountSpec = { kind: 'usd'; value: number } | { kind: 'token'; token: string; value: string } | { kind: 'max' };

export interface CreateRequest {
  chainId: EvmChainId;
  pair?: [string, string];
  pool?: string;
  feeTier?: number;
  lower?: Limit;
  upper?: Limit;
  fullRange?: boolean;
  amount: AmountSpec;
  wallet: string;
  /** Price move tolerated between planning and the mint landing, as a fraction: 0.005 = 0.5%. */
  slippage: number;
  deadlineSeconds: number;
  payWith: 'auto' | 'weth' | 'eth';
  approve: 'exact' | 'unlimited';
  pricesUrl?: string;
  now?: () => number;
}

export interface PlanToken { address: string; symbol: string; decimals: number; priceUsd?: number }
export interface PlanTransaction { description: string; to: string; data: Hex; value: string }

export interface CreatePlan {
  chainId: EvmChainId;
  wallet: string;
  manager: string;
  pool: { address: string; feeTier: number; tickSpacing: number; tvlUsd?: number; others: Array<{ feeTier: number; address: string; tvlUsd?: number }> };
  token0: PlanToken;
  token1: PlanToken;
  /** Prices are shown as quote per base, e.g. USDC per WETH; inverted when that is token0 per token1. */
  unit: string;
  inverted: boolean;
  price: number;
  range: { lower: number; upper: number; lowerPct: number; upperPct: number; tickLower: number; tickUpper: number; fullRange: boolean; inRange: boolean };
  /** payNative: the WETH side (nativeSide: 0 or 1) is paid in ETH. */
  deposit: { amount0: string; amount1: string; min0: string; min1: string; valueUsd?: number; liquidity: string; payNative: boolean; nativeSide?: 0 | 1 };
  wallets: { native: string; balance0: string; balance1: string };
  volatility?: { dailyPct: number; days: number; daysToLower?: number; daysToUpper?: number };
  transactions: PlanTransaction[];
  simulation: { status: 'passed' | 'failed' | 'after-approvals'; message?: string; tokenId?: string; gas?: string };
  deadline: string;
  ready: boolean;
  warnings: string[];
}

export async function planPosition(request: CreateRequest, rpc: RpcProvider, report: (message: string) => void = () => {}): Promise<CreatePlan> {
  const { chainId } = request;
  const client = rpc.client(chainId);
  const manager = V3_POSITIONS[chainId];
  const wallet = request.wallet.toLowerCase() as Address;
  const network = CHAINS[chainId].name;
  const read = <T>(address: string, abi: readonly unknown[], functionName: string, args: unknown[] = []): Promise<T> =>
    client.readContract({ address: address as Address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

  // 1. The pool: given by address, or found from the pair at the requested fee tier (or the deepest tier).
  let candidates: Array<{ address: string; feeTier: number }>;
  let addresses: [string, string];
  if (request.pool) {
    const address = request.pool.toLowerCase();
    const [token0, token1, fee] = await Promise.all([read<string>(address, poolAbi, 'token0'), read<string>(address, poolAbi, 'token1'), read<number>(address, poolAbi, 'fee')])
      .catch(() => { throw new Error(`${request.pool} is not a Uniswap v3 pool on ${network}.`); });
    addresses = [token0.toLowerCase(), token1.toLowerCase()];
    candidates = [{ address, feeTier: fee }];
  } else {
    const [a, b] = request.pair!.map((query) => {
      const address = tokenAddress(chainId, query);
      if (!address) throw new Error(`Token "${query}" is not known on ${network}. Use its contract address, or one of ${knownSymbols(chainId).join(', ')}.`);
      return address;
    }) as [string, string];
    if (a === b) throw new Error('The pair needs two different tokens.');
    addresses = a < b ? [a, b] : [b, a];
    const tiers = request.feeTier === undefined ? FEE_TIERS : [request.feeTier];
    const found = await Promise.all(tiers.map(async (feeTier) => ({ feeTier, address: (await read<string>(V3_FACTORIES[chainId], factoryAbi, 'getPool', [...addresses, feeTier])).toLowerCase() })));
    candidates = found.filter((pool) => !/^0x0{40}$/.test(pool.address));
    if (!candidates.length) {
      throw new Error(request.feeTier === undefined
        ? `No Uniswap v3 pool exists for ${request.pair!.join('/')} on ${network}.`
        : `No ${request.feeTier / 10_000}% Uniswap v3 pool exists for ${request.pair!.join('/')} on ${network}. Leave out --fee to use the deepest pool.`);
    }
  }

  // 2. Tokens: symbol and decimals from their contracts, USD prices from DefiLlama (optional).
  const token = async (address: string): Promise<PlanToken> => {
    const [symbol, decimals] = await Promise.all([read<string>(address, erc20Abi, 'symbol').catch(() => `${address.slice(0, 6)}…`), read<number>(address, erc20Abi, 'decimals')]);
    return { address, symbol, decimals: Number(decimals) };
  };
  const [token0, token1] = await Promise.all(addresses.map(token)) as [PlanToken, PlanToken];
  const prices = await usdPrices(addresses.map((address) => ({ chainId, address })), { endpoint: request.pricesUrl })
    .catch((error: Error) => { report(`USD prices are unavailable (${error.message}).`); return new Map<string, number>(); });
  token0.priceUsd = prices.get(`${chainId}:${token0.address}`);
  token1.priceUsd = prices.get(`${chainId}:${token1.address}`);

  // 3. Pool state and depth. Without --fee the deepest pool (by the value of the tokens it holds) is used.
  const scale = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals));
  const states = await Promise.all(candidates.map(async (candidate) => {
    const [slot0, spacing, held0, held1] = await Promise.all([
      read<readonly [bigint, number]>(candidate.address, poolAbi, 'slot0'), read<number>(candidate.address, poolAbi, 'tickSpacing'),
      read<bigint>(token0.address, erc20Abi, 'balanceOf', [candidate.address]), read<bigint>(token1.address, erc20Abi, 'balanceOf', [candidate.address]),
    ]);
    const poolPrice = (Number(slot0[0]) / 2 ** 96) ** 2 * 10 ** (token0.decimals - token1.decimals);
    const price0 = token0.priceUsd ?? (token1.priceUsd !== undefined ? poolPrice * token1.priceUsd : undefined);
    const price1 = token1.priceUsd ?? (token0.priceUsd !== undefined ? token0.priceUsd / poolPrice : undefined);
    const tvlUsd = price0 !== undefined && price1 !== undefined ? scale(held0, token0.decimals) * price0 + scale(held1, token1.decimals) * price1 : undefined;
    // Depth in token1 units ranks pools even without USD prices.
    const depth = scale(held0, token0.decimals) * poolPrice + scale(held1, token1.decimals);
    return { ...candidate, sqrtPrice: slot0[0], tick: Number(slot0[1]), spacing: Number(spacing), poolPrice, tvlUsd, depth };
  }));
  states.sort((a, b) => b.depth - a.depth);
  const pool = states[0]!;
  if (pool.sqrtPrice === 0n) throw new Error('This pool has not been initialized with a price; it cannot take liquidity yet.');
  token0.priceUsd ??= token1.priceUsd !== undefined ? pool.poolPrice * token1.priceUsd : undefined;
  token1.priceUsd ??= token0.priceUsd !== undefined ? token0.priceUsd / pool.poolPrice : undefined;

  // 4. Range: limits are given in the displayed unit (quote per base); ticks are widened outward to the tick spacing.
  const inverted = invertPrice(token0.symbol, token1.symbol);
  const [base, quote] = inverted ? [token1, token0] : [token0, token1];
  const display = (poolPrice: number) => inverted ? 1 / poolPrice : poolPrice;
  const price = display(pool.poolPrice);
  const [minTick, maxTick] = usableTickBounds(pool.spacing);
  let tickLower: number;
  let tickUpper: number;
  if (request.fullRange) {
    [tickLower, tickUpper] = [minTick, maxTick];
  } else {
    const limit = (value: Limit) => value.kind === 'percent' ? price * (1 + value.value / 100) : value.value;
    const [low, high] = [limit(request.lower!), limit(request.upper!)];
    if (!(low > 0)) throw new Error('--lower-limit must leave a positive price, e.g. -15% or a price above 0.');
    if (!(high > low)) throw new Error(`--upper-limit (${high.toPrecision(6)}) must be above --lower-limit (${low.toPrecision(6)}) ${quote.symbol} per ${base.symbol}.`);
    // Raw pool prices (token1 per token0, without decimals) at the range edges.
    const raw = (displayed: number) => (inverted ? 1 / displayed : displayed) * 10 ** (token1.decimals - token0.decimals);
    const [rawLow, rawHigh] = inverted ? [raw(high), raw(low)] : [raw(low), raw(high)];
    tickLower = Math.max(minTick, Math.floor(tickAtOrBelowPrice(rawLow) / pool.spacing) * pool.spacing);
    tickUpper = Math.min(maxTick, Math.ceil(tickAtOrBelowPrice(rawHigh) / pool.spacing) * pool.spacing);
    if (tickUpper <= tickLower) tickUpper = tickLower + pool.spacing;
  }
  const tickPrice = (tick: number) => display(1.0001 ** tick * 10 ** (token0.decimals - token1.decimals));
  const [rangeLow, rangeHigh] = inverted ? [tickPrice(tickUpper), tickPrice(tickLower)] : [tickPrice(tickLower), tickPrice(tickUpper)];
  const [sqrtLower, sqrtUpper] = [sqrtRatioAtTick(tickLower), sqrtRatioAtTick(tickUpper)];
  const inRange = pool.sqrtPrice > sqrtLower && pool.sqrtPrice < sqrtUpper;

  // 5. Wallet: balances, allowances for the position manager, and whether WETH can be paid in native ETH.
  const weth = (await read<string>(manager, managerAbi, 'WETH9')).toLowerCase();
  const [native, balance0, balance1, allowance0, allowance1] = await Promise.all([
    client.getBalance({ address: wallet }),
    read<bigint>(token0.address, erc20Abi, 'balanceOf', [wallet]), read<bigint>(token1.address, erc20Abi, 'balanceOf', [wallet]),
    read<bigint>(token0.address, erc20Abi, 'allowance', [wallet, manager]), read<bigint>(token1.address, erc20Abi, 'allowance', [wallet, manager]),
  ]);
  const wethSide = token0.address === weth ? 0 : token1.address === weth ? 1 : undefined;
  if (request.payWith === 'eth' && wethSide === undefined) throw new Error('--pay-with eth needs a pair with WETH.');
  const spareNative = native > GAS_RESERVE ? native - GAS_RESERVE : 0n;

  // 6. Amounts: liquidity from the requested deposit, then the exact token amounts the mint takes.
  const amount = request.amount;
  let liquidity: bigint;
  if (amount.kind === 'token') {
    const address = tokenAddress(chainId, amount.token);
    const side = address === token0.address ? 0 : address === token1.address ? 1 : undefined;
    if (side === undefined) throw new Error(`--amount names ${amount.token}, which is not in this pool (${token0.symbol}/${token1.symbol}).`);
    const info = side === 0 ? token0 : token1;
    const other = side === 0 ? token1 : token0;
    if ((side === 0 && pool.sqrtPrice >= sqrtUpper) || (side === 1 && pool.sqrtPrice <= sqrtLower)) {
      throw new Error(`The range is entirely ${side === 0 ? 'below' : 'above'} the current price, so the position holds only ${other.symbol}. Give the amount in ${other.symbol}.`);
    }
    const value = parseUnits(amount.value, info.decimals);
    liquidity = side === 0 ? liquidityForAmounts(pool.sqrtPrice, sqrtLower, sqrtUpper, value, MAX_UINT256 >> 64n) : liquidityForAmounts(pool.sqrtPrice, sqrtLower, sqrtUpper, MAX_UINT256 >> 64n, value);
  } else if (amount.kind === 'usd') {
    const reference = 10n ** 24n;
    const [ref0, ref1] = amountsForLiquidity(pool.sqrtPrice, sqrtLower, sqrtUpper, reference);
    const missing = [ref0 > 0n && token0.priceUsd === undefined ? token0.symbol : '', ref1 > 0n && token1.priceUsd === undefined ? token1.symbol : ''].filter(Boolean);
    if (missing.length) throw new Error(`No USD price for ${missing.join(' and ')}. Give the amount in a token instead, e.g. --amount 0.05${token0.symbol.toLowerCase()}.`);
    const value = scale(ref0, token0.decimals) * (token0.priceUsd ?? 0) + scale(ref1, token1.decimals) * (token1.priceUsd ?? 0);
    liquidity = BigInt(Math.floor(Number(reference) * amount.value / value));
  } else {
    const funds0 = balance0 + (wethSide === 0 && request.payWith !== 'weth' ? spareNative : 0n);
    const funds1 = balance1 + (wethSide === 1 && request.payWith !== 'weth' ? spareNative : 0n);
    liquidity = liquidityForAmounts(pool.sqrtPrice, sqrtLower, sqrtUpper, funds0, funds1);
  }
  if (liquidity <= 0n) throw new Error(amount.kind === 'max' ? `The wallet has no ${token0.symbol} or ${token1.symbol} to deposit for this range.` : 'The amount is too small to provide any liquidity.');
  const [amount0, amount1] = amountsForLiquidity(pool.sqrtPrice, sqrtLower, sqrtUpper, liquidity);
  const [min0, min1] = minimumAmounts(pool.sqrtPrice, sqrtLower, sqrtUpper, amount0, amount1, request.slippage);
  const valueUsd = token0.priceUsd !== undefined && token1.priceUsd !== undefined ? scale(amount0, token0.decimals) * token0.priceUsd + scale(amount1, token1.decimals) * token1.priceUsd : undefined;

  // 7. Paying: WETH from the wallet's WETH, or native ETH wrapped by the position manager when WETH is short.
  const wethNeed = wethSide === 0 ? amount0 : wethSide === 1 ? amount1 : 0n;
  const wethBalance = wethSide === 0 ? balance0 : wethSide === 1 ? balance1 : 0n;
  const payNative = wethNeed > 0n && (request.payWith === 'eth' || (request.payWith === 'auto' && wethBalance < wethNeed && spareNative >= wethNeed));
  const warnings: string[] = [];
  const shortfall = (need: bigint, have: bigint, info: PlanToken) => {
    if (have < need) warnings.push(`The wallet is short ${show(need - have, info.decimals)} ${info.symbol} (needs ${show(need, info.decimals)}, has ${show(have, info.decimals)}). Swap into ${info.symbol} or lower --amount, then run this again.`);
  };
  shortfall(wethSide === 0 && payNative ? 0n : amount0, balance0, token0);
  shortfall(wethSide === 1 && payNative ? 0n : amount1, balance1, token1);
  if (payNative && spareNative < wethNeed) warnings.push(`The wallet is short ${show(wethNeed - spareNative, 18)} ETH to pay the WETH side natively (keeping ${show(GAS_RESERVE, 18)} ETH for gas).`);
  if (native < GAS_RESERVE / 5n) warnings.push(`The wallet has only ${show(native, 18)} ETH on ${network} for gas.`);

  // 8. Transactions: approvals only where the allowance is short (exact amounts by default), then the mint.
  const transactions: PlanTransaction[] = [];
  const approvals: Array<[PlanToken, bigint, bigint]> = [[token0, amount0, allowance0], [token1, amount1, allowance1]];
  for (const [info, need, allowance] of approvals) {
    if (need === 0n || (payNative && info.address === weth) || allowance >= need) continue;
    const approve = (value: bigint, description: string) => transactions.push({ description, to: info.address, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [manager, value] }) });
    // USDT-style tokens refuse to change a non-zero allowance to another non-zero one.
    if (allowance > 0n && /^usd(t|₮)/i.test(info.symbol)) approve(0n, `Reset the ${info.symbol} allowance to 0`);
    const value = request.approve === 'unlimited' ? MAX_UINT256 : need;
    approve(value, `Approve ${request.approve === 'unlimited' ? 'unlimited' : show(need, info.decimals)} ${info.symbol} for the Uniswap v3 position manager`);
  }
  const now = Math.floor((request.now ?? Date.now)() / 1000);
  const deadline = BigInt(now + request.deadlineSeconds);
  const mint = encodeFunctionData({ abi: managerAbi, functionName: 'mint', args: [{
    token0: token0.address as Address, token1: token1.address as Address, fee: pool.feeTier, tickLower, tickUpper,
    amount0Desired: amount0, amount1Desired: amount1, amount0Min: min0, amount1Min: min1, recipient: wallet, deadline,
  }] });
  // Paying in ETH sends the WETH amount as value; refundETH returns whatever the mint did not use.
  const data = payNative ? encodeFunctionData({ abi: managerAbi, functionName: 'multicall', args: [[mint, encodeFunctionData({ abi: managerAbi, functionName: 'refundETH' })]] }) : mint;
  const mintTx: PlanTransaction = { description: `Create the ${token0.symbol}/${token1.symbol} ${pool.feeTier / 10_000}% position`, to: manager, data, value: (payNative ? wethNeed : 0n).toString() };
  transactions.push(mintTx);

  // 9. Simulate the mint from the wallet when nothing else must happen first; the node reports any revert reason.
  let simulation: CreatePlan['simulation'];
  if (transactions.length > 1) simulation = { status: 'after-approvals', message: 'Sign the approvals, then run this command again to check the mint against the new allowances and a fresh price.' };
  else if (warnings.some((warning) => warning.includes('short'))) simulation = { status: 'failed', message: 'Not simulated: the wallet does not hold the tokens yet.' };
  else {
    try {
      const call = { account: wallet, to: manager as Address, data, value: BigInt(mintTx.value) };
      const result = await client.call(call);
      const returned = result.data && (payNative
        ? decodeFunctionResult({ abi: managerAbi, functionName: 'mint', data: (decodeFunctionResult({ abi: managerAbi, functionName: 'multicall', data: result.data }) as readonly Hex[])[0]! })
        : decodeFunctionResult({ abi: managerAbi, functionName: 'mint', data: result.data }));
      const gas = await client.estimateGas(call).catch(() => undefined);
      simulation = { status: 'passed', tokenId: returned ? (returned as readonly [bigint, ...unknown[]])[0].toString() : undefined, gas: gas?.toString() };
    } catch (error) {
      simulation = { status: 'failed', message: ((error as { shortMessage?: string }).shortMessage ?? (error as Error).message).split('\n')[0] };
    }
  }

  // 10. Range check against recent volatility: how long a typical move takes to reach each limit.
  let volatility: CreatePlan['volatility'];
  if (!request.fullRange) {
    try {
      const days = 30;
      const history = await dailyPrices([token0, token1].map((info) => ({ chainId, address: info.address })), days, { endpoint: request.pricesUrl });
      const series0 = history.get(`${chainId}:${token0.address}`);
      const series1 = history.get(`${chainId}:${token1.address}`);
      if (series0 && series1 && Math.min(series0.length, series1.length) >= 8) {
        const length = Math.min(series0.length, series1.length);
        const ratios = Array.from({ length }, (_, i) => series0[series0.length - length + i]! / series1[series1.length - length + i]!);
        const returns = ratios.slice(1).map((ratio, i) => Math.log(ratio / ratios[i]!));
        const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
        const sigma = Math.sqrt(returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1));
        // A random walk with daily volatility sigma typically covers a distance d in (d / sigma)^2 days.
        const reach = (edge: number) => sigma > 0 && edge > 0 ? (Math.log(edge) / sigma) ** 2 : undefined;
        volatility = {
          dailyPct: sigma * 100, days: length - 1,
          daysToLower: inRange ? reach(price / rangeLow) : undefined,
          daysToUpper: inRange ? reach(rangeHigh / price) : undefined,
        };
      }
    } catch (error) { report(`Price history is unavailable (${(error as Error).message}); skipping the volatility check.`); }
  }
  const soonest = Math.min(volatility?.daysToLower ?? Infinity, volatility?.daysToUpper ?? Infinity);
  if (soonest < 7) warnings.push(`A typical move leaves this range in about ${soonest < 1 ? 'a day' : `${Math.round(soonest)} days`}. Out of range, the position earns no fees and holds only one token; consider a wider range.`);
  if (!inRange) warnings.push(`The range does not include the current price: the position starts out of range, holding only ${amount0 > 0n ? token0.symbol : token1.symbol}, and earns no fees until the price enters it.`);
  const stable = (info: PlanToken) => /^(usd|dai|gho|frax|lusd)/i.test(info.symbol);
  if (pool.feeTier === 100 && !(stable(token0) && stable(token1))) warnings.push('The 0.01% tier is meant for stablecoin pairs; volatile pairs earn little there for the risk. Consider --fee 0.05 or 0.3.');
  if (states.length > 1 && request.feeTier === undefined) report(`Using the deepest pool, ${pool.feeTier / 10_000}%. Other tiers: ${states.slice(1).map((state) => `${state.feeTier / 10_000}%`).join(', ')}; choose one with --fee.`);

  const ready = simulation.status === 'passed' || (simulation.status === 'after-approvals' && !warnings.some((warning) => warning.includes('short')));
  return {
    chainId, wallet, manager,
    pool: { address: pool.address, feeTier: pool.feeTier, tickSpacing: pool.spacing, tvlUsd: pool.tvlUsd, others: states.slice(1).map((state) => ({ feeTier: state.feeTier, address: state.address, tvlUsd: state.tvlUsd })) },
    token0, token1, unit: `${quote.symbol} per ${base.symbol}`, inverted, price,
    range: { lower: rangeLow, upper: rangeHigh, lowerPct: (rangeLow / price - 1) * 100, upperPct: (rangeHigh / price - 1) * 100, tickLower, tickUpper, fullRange: Boolean(request.fullRange), inRange },
    deposit: {
      amount0: formatUnits(amount0, token0.decimals), amount1: formatUnits(amount1, token1.decimals),
      min0: formatUnits(min0, token0.decimals), min1: formatUnits(min1, token1.decimals), valueUsd, liquidity: liquidity.toString(), payNative, nativeSide: payNative ? wethSide : undefined,
    },
    wallets: { native: formatUnits(native, 18), balance0: formatUnits(balance0, token0.decimals), balance1: formatUnits(balance1, token1.decimals) },
    volatility, transactions, simulation, deadline: new Date(Number(deadline) * 1000).toISOString(), ready, warnings,
  };
}

/** "-15%", "+10%", "10%" (relative to the current price) or "2100" (a price in the displayed unit). */
export function parseLimit(value: string, optionName: string): Limit {
  const text = value.trim().replaceAll(',', '');
  const percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(text);
  if (percent) {
    const number = Number(percent[1]);
    if (number <= -100) throw new Error(`${optionName} ${value} would put the price at or below zero.`);
    return { kind: 'percent', value: number };
  }
  if (/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) && Number(text) > 0) return { kind: 'price', value: Number(text) };
  throw new Error(`${optionName} "${value}" is not a limit: use a percentage from the current price such as -15% or +10%, or a price such as 2100.`);
}

/** "100usd", "$100", "0.05weth", "0.05 ETH", "150 USDC", or "max". */
export function parseAmount(value: string): AmountSpec {
  const text = value.trim().replaceAll(',', '');
  if (/^max$/i.test(text)) return { kind: 'max' };
  const usd = /^\$(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*usd$/i.exec(text);
  if (usd) {
    const number = Number(usd[1] ?? usd[2]);
    if (number > 0) return { kind: 'usd', value: number };
  }
  const token = /^(\d+(?:\.\d+)?)\s*([a-z][a-z0-9.]*|0x[0-9a-f]{40})$/i.exec(text);
  if (token && Number(token[1]) > 0 && !/^usd$/i.test(token[2]!)) return { kind: 'token', token: token[2]!, value: token[1]! };
  throw new Error(`--amount "${value}" is not an amount: use a USD total (100usd or $100), a token amount (0.05weth, 150usdc), or max.`);
}

/** "20m", "1h", "90s"; a bare number is minutes. */
export function parseDeadline(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(value.trim());
  const seconds = match ? Number(match[1]) * { s: 1, m: 60, h: 3600 }[(match[2] ?? 'm').toLowerCase() as 's' | 'm' | 'h'] : NaN;
  if (!(seconds >= 60) || seconds > 86_400) throw new Error(`--deadline "${value}" must be between 1m and 24h, e.g. 20m.`);
  return Math.round(seconds);
}

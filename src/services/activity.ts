import { parseChains, parsePositiveInt } from '../config.js';
import type { Store } from '../storage.js';
import { AlchemyClient } from '../providers/alchemy.js';
import { RevertClient } from '../providers/revert.js';
import { RpcProvider } from '../providers/rpc.js';
import { walletHistory, type HistoryResult } from '../history.js';
import { parseAmount, parseDeadline, parseLimit, planPosition, type CreatePlan } from '../create-position.js';
import { CREATE_CHAINS } from '../providers/tokens.js';
import { ACTIVITY_KINDS, CHAINS, isEvmChain, type ActivityKind, type AppConfig, type EvmChainId } from '../types.js';
import { historyTargets, parseWalletChain, planWallet, type Report } from './wallets.js';
import { parsePair } from './pools.js';

// wallet history and positions create as data functions, shared by the CLI and the dashboard.

export interface HistoryRequest {
  /** Saved wallet name, 0x address, or all; the default wallet when absent. */
  target?: string;
  chain?: string;
  days: string;
  type?: string;
  top: string;
  all?: boolean;
}

export interface WalletHistory { wallets: string[]; address: string; chains: EvmChainId[]; result: HistoryResult }

export function parseKinds(value: string | undefined): ActivityKind[] | undefined {
  if (value === undefined) return undefined;
  const kinds = [...new Set(value.toLowerCase().split(',').map((kind) => kind.trim()).flatMap((kind) => kind === 'lp' ? ['add-liquidity', 'remove-liquidity', 'collect-fees'] : [kind]))] as ActivityKind[];
  const unknown = kinds.find((kind) => !(ACTIVITY_KINDS as readonly string[]).includes(kind));
  if (unknown !== undefined) throw new Error(`--type "${unknown || '(empty)'}" is not a kind. Use ${ACTIVITY_KINDS.join(', ')}, or lp.`);
  return kinds;
}

export async function loadHistory(request: HistoryRequest, { config, store, report, quiet }: { config: AppConfig; store: Store; report: Report; quiet?: boolean }): Promise<{ several: boolean; days: number; histories: WalletHistory[]; alchemy: boolean }> {
  const days = parsePositiveInt(request.days, '--days')!;
  if (days > 365) throw new Error('--days supports 1 through 365.');
  const top = parsePositiveInt(request.top, '--top')!;
  if (top > 500) throw new Error('--top supports 1 through 500.');
  const { several, targets } = historyTargets(request.target, parseChains(request.chain), store, { report, quiet });
  const kinds = parseKinds(request.type);
  const alchemy = config.alchemyApiKey || process.env.DEFI_TOOL_ALCHEMY_URL
    ? new AlchemyClient({ apiKey: config.alchemyApiKey ?? '', endpoint: process.env.DEFI_TOOL_ALCHEMY_URL }) : undefined;
  if (!alchemy && !quiet) report('Note: ALCHEMY_API_KEY is not set, so only liquidity activity is shown. A free key adds swaps and transfers.');
  const revert = new RevertClient({ endpoint: process.env.DEFI_TOOL_REVERT_URL });
  const histories: WalletHistory[] = [];
  for (const item of targets) {
    const result = await walletHistory({
      address: item.address, chains: item.chains, since: Math.floor(Date.now() / 1000) - days * 86_400, kinds, top, includeSpam: Boolean(request.all), pricesUrl: process.env.DEFI_TOOL_PRICES_URL,
    }, { revert, alchemy }, (message) => report(several ? `${item.names.join(', ')}: ${message}` : message));
    histories.push({ wallets: item.names, address: item.address, chains: item.chains, result });
  }
  return { several, days, histories, alchemy: Boolean(alchemy) };
}

export interface PlanRequest {
  pair?: string;
  chain: string;
  wallet?: string;
  amount: string;
  lowerLimit?: string;
  upperLimit?: string;
  fullRange?: boolean;
  fee?: string;
  pool?: string;
  slippage: string;
  deadline: string;
  payWith: 'auto' | 'weth' | 'eth';
  approve: 'exact' | 'unlimited';
}

const V3_FEES: Record<string, number> = { '0.01': 100, '0.05': 500, '0.3': 3000, '0.30': 3000, '1': 10_000, '1.0': 10_000 };

/** Check a positions create request and build the plan. Nothing is signed or sent. */
export async function buildPlan(request: PlanRequest, { config, store, report, quiet }: { config: AppConfig; store: Store; report: Report; quiet?: boolean }): Promise<CreatePlan> {
  const chainId = parseWalletChain(request.chain);
  if (!isEvmChain(chainId) || !CREATE_CHAINS.includes(chainId)) throw new Error(`positions create supports ${CREATE_CHAINS.map((chain) => CHAINS[chain].name).join(' and ')} for now.`);
  if (Boolean(request.pair) === Boolean(request.pool)) throw new Error('Give a pair such as WETH/USDC, or --pool <address>, but not both.');
  if (request.pool && !/^0x[0-9a-fA-F]{40}$/.test(request.pool)) throw new Error('--pool must be a 0x pool address.');
  if (request.fee !== undefined && request.pool) throw new Error('--fee is implied by --pool; leave it out.');
  const feeTier = request.fee === undefined ? undefined : V3_FEES[request.fee.trim().replace(/%$/, '')];
  if (request.fee !== undefined && feeTier === undefined) throw new Error(`--fee "${request.fee}" is not a Uniswap v3 tier: use 0.01, 0.05, 0.3 or 1.`);
  if (request.fullRange && (request.lowerLimit || request.upperLimit)) throw new Error('Use --full-range or --lower-limit/--upper-limit, not both.');
  if (!request.fullRange && (!request.lowerLimit || !request.upperLimit)) throw new Error('Give both --lower-limit and --upper-limit (e.g. --lower-limit -15% --upper-limit +10%), or --full-range.');
  const slippage = Number(request.slippage.replace(/%$/, ''));
  if (!(slippage > 0 && slippage <= 50)) throw new Error('--slippage must be a percentage above 0 and at most 50, e.g. 0.5.');
  const wallet = planWallet(store, request.wallet, { report, quiet });
  return planPosition({
    chainId, pair: request.pair ? parsePair(request.pair) : undefined, pool: request.pool, feeTier,
    lower: request.lowerLimit ? parseLimit(request.lowerLimit, '--lower-limit') : undefined,
    upper: request.upperLimit ? parseLimit(request.upperLimit, '--upper-limit') : undefined,
    fullRange: request.fullRange, amount: parseAmount(request.amount), wallet, slippage: slippage / 100,
    deadlineSeconds: parseDeadline(request.deadline), payWith: request.payWith, approve: request.approve, pricesUrl: process.env.DEFI_TOOL_PRICES_URL,
  }, new RpcProvider(config.rpcUrls), report);
}

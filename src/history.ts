import { CHAINS, type ActivityKind, type EvmChainId, type Leg, type WalletActivity } from './types.js';
import type { AlchemyClient, Receipt, Transfer } from './providers/alchemy.js';
import type { RevertClient } from './providers/revert.js';
import { assetPriceKey, coinPrices, historicalPrices } from './providers/prices.js';
import { knownTokens } from './providers/tokens.js';

/**
 * Wallet history: liquidity activity from Revert Finance (no key) merged with swaps and transfers from Alchemy (free key),
 * one entry per transaction, newest first, valued in USD at the time of each transaction.
 */

const EXPLORERS: Partial<Record<EvmChainId, string>> = {
  1: 'https://etherscan.io', 10: 'https://optimistic.etherscan.io', 56: 'https://bscscan.com', 137: 'https://polygonscan.com',
  8453: 'https://basescan.org', 42161: 'https://arbiscan.io',
};
/** Wrapped native coins, for telling wraps and unwraps apart from swaps. */
const WRAPPED: Partial<Record<EvmChainId, string>> = {
  1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 10: '0x4200000000000000000000000000000000000006', 56: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', 8453: '0x4200000000000000000000000000000000000006', 42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};

export interface HistoryRequest {
  address: string;
  chains: EvmChainId[];
  /** Earliest time included, in seconds. */
  since: number;
  kinds?: readonly ActivityKind[];
  top: number;
  includeSpam: boolean;
  pricesUrl?: string;
  /** For tests: the fetch used for DefiLlama prices. */
  fetcher?: typeof fetch;
}

export interface HistorySummary {
  transactions: number;
  byKind: Partial<Record<ActivityKind, number>>;
  /** USD sold in swaps, and what the swaps cost: value sent minus value received (price impact, pool fees, MEV). */
  swapVolumeUsd: number;
  swapCostUsd: number;
  addedUsd: number;
  removedUsd: number;
  feesCollectedUsd: number;
  gasUsd: number;
}

export interface HistoryResult {
  activities: WalletActivity[];
  /** Matching transactions in the window before --top was applied. */
  total: number;
  spamHidden: number;
  summary: HistorySummary;
  sources: string[];
}

export async function walletHistory(request: HistoryRequest, clients: { revert: RevertClient; alchemy?: AlchemyClient }, report: (message: string) => void): Promise<HistoryResult> {
  const address = request.address.toLowerCase();
  const sources: string[] = [];
  let failures = 0;

  // 1. Liquidity activity (Revert) and transfers (Alchemy) in parallel; a failing source or network is reported, not fatal.
  const [lp, transfers] = await Promise.all([
    clients.revert.activity(address, request.chains).then((found) => { sources.push('Revert Finance'); return found; })
      .catch((error: Error) => { failures += 1; report(`Liquidity history is unavailable: ${error.message}`); return [] as WalletActivity[]; }),
    Promise.all(request.chains.map(async (chainId) => {
      if (!clients.alchemy) return [] as Array<[EvmChainId, Transfer[]]>;
      if (!clients.alchemy.supports(chainId)) { report(`Swaps and transfers on ${CHAINS[chainId].name} are not indexed by Alchemy; showing liquidity activity only there.`); return []; }
      try { return [[chainId, await clients.alchemy.transfers(address, chainId, request.since)] as [EvmChainId, Transfer[]]]; } catch (error) {
        failures += 1;
        report(`${CHAINS[chainId].name}: swaps and transfers are unavailable: ${(error as Error).message}`);
        return [];
      }
    })).then((lists) => lists.flat()),
  ]);
  if (transfers.length) sources.push('Alchemy');
  if (failures && !sources.length) throw new Error('No history source could be reached; see the messages above.');

  // 2. One entry per transaction. Liquidity transactions come from Revert, whose amounts and prices are exact.
  const lpHashes = new Set(lp.map((activity) => `${activity.chainId}:${activity.hash.toLowerCase()}`));
  const transferActivities = transfers.flatMap(([chainId, list]) => {
    const byHash = new Map<string, Transfer[]>();
    for (const transfer of list) byHash.set(transfer.hash, [...(byHash.get(transfer.hash) ?? []), transfer]);
    return [...byHash].filter(([hash]) => !lpHashes.has(`${chainId}:${hash}`)).map(([hash, group]) => classify(chainId, hash, group, address));
  });
  let activities = [...lp.filter((activity) => Date.parse(activity.timestamp) / 1000 >= request.since), ...transferActivities];
  if (request.kinds) activities = activities.filter((activity) => request.kinds!.includes(activity.kind));
  activities.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.hash.localeCompare(b.hash));

  // 3. Likely spam: receipts of tokens that are neither well known nor priced by DefiLlama.
  const suspects = activities.filter((activity) => activity.kind === 'receive' && activity.received.every((leg) => leg.address && !knownTokens(activity.chainId).includes(leg.address)));
  if (suspects.length) {
    const keys = suspects.flatMap((activity) => activity.received.map((leg) => assetPriceKey(activity.chainId, leg.address)));
    const priced = await coinPrices(keys, { endpoint: request.pricesUrl, fetcher: request.fetcher }).catch(() => undefined);
    if (priced) for (const activity of suspects) activity.spam = activity.received.every((leg) => !priced.has(assetPriceKey(activity.chainId, leg.address).toLowerCase()));
  }
  const spamHidden = request.includeSpam ? 0 : activities.filter((activity) => activity.spam).length;
  if (!request.includeSpam) activities = activities.filter((activity) => !activity.spam);
  const total = activities.length;
  activities = activities.slice(0, request.top);

  // 4. Gas for transfer transactions the wallet sent (Revert already has it for liquidity), from receipts.
  if (clients.alchemy) {
    await Promise.all(request.chains.map(async (chainId) => {
      const pending = activities.filter((activity) => activity.chainId === chainId && activity.source === 'alchemy');
      if (!pending.length) return;
      const receipts: Map<string, Receipt> = await clients.alchemy!.receipts(chainId, pending.map((activity) => activity.hash))
        .catch((error: Error) => { report(`${CHAINS[chainId].name}: gas fees are unavailable: ${error.message}`); return new Map(); });
      for (const activity of pending) {
        const receipt = receipts.get(activity.hash);
        if (receipt?.from === address) activity.gasNative = receipt.gasNative;
      }
    }));
  }

  // 5. USD values at the time of each transaction, in one batch of historical prices.
  const needed: Array<{ key: string; timestamp: number }> = [];
  const at = (activity: WalletActivity) => Math.floor(Date.parse(activity.timestamp) / 1000);
  for (const activity of activities) {
    for (const leg of [...activity.sent, ...activity.received, ...(activity.fees ?? [])]) if (leg.valueUsd === undefined) needed.push({ key: assetPriceKey(activity.chainId, leg.address), timestamp: at(activity) });
    if (activity.gasNative !== undefined && activity.gasUsd === undefined) needed.push({ key: assetPriceKey(activity.chainId), timestamp: at(activity) });
  }
  if (needed.length) {
    const prices = await historicalPrices(needed, { endpoint: request.pricesUrl, fetcher: request.fetcher })
      .catch((error: Error) => { report(`USD values are unavailable: ${error.message}`); return new Map<string, number>(); });
    const price = (activity: WalletActivity, address?: string) => prices.get(`${assetPriceKey(activity.chainId, address).toLowerCase()}@${at(activity)}`);
    for (const activity of activities) {
      for (const leg of [...activity.sent, ...activity.received, ...(activity.fees ?? [])]) {
        const unit = leg.valueUsd === undefined ? price(activity, leg.address) : undefined;
        if (unit !== undefined) leg.valueUsd = leg.amount * unit;
      }
      const native = activity.gasNative !== undefined && activity.gasUsd === undefined ? price(activity) : undefined;
      if (native !== undefined) activity.gasUsd = activity.gasNative! * native;
    }
  }
  for (const activity of activities) activity.explorerUrl = EXPLORERS[activity.chainId] && `${EXPLORERS[activity.chainId]}/tx/${activity.hash}`;
  return { activities, total, spamHidden, summary: summarize(activities), sources };
}

/** What a transaction did, from the transfers into and out of the wallet. */
function classify(chainId: EvmChainId, hash: string, group: Transfer[], wallet: string): WalletActivity {
  const leg = (transfer: Transfer): Leg => ({ symbol: transfer.symbol, address: transfer.address, amount: transfer.amount });
  // Several transfers of one asset in one direction (e.g. split routes) add up to one leg.
  const merge = (legs: Leg[]) => [...legs.reduce((map, item) => {
    const key = item.address ?? 'native';
    const current = map.get(key);
    return map.set(key, current ? { ...current, amount: current.amount + item.amount } : item);
  }, new Map<string, Leg>()).values()];
  const outgoing = group.filter((transfer) => transfer.from === wallet && transfer.to !== wallet);
  const incoming = group.filter((transfer) => transfer.to === wallet && transfer.from !== wallet);
  const [sent, received] = [merge(outgoing.map(leg)), merge(incoming.map(leg))];
  const wrapped = WRAPPED[chainId];
  let kind: ActivityKind;
  let counterparty: string | undefined;
  if (sent.length && received.length) {
    const ids = (legs: Leg[]) => legs.map((item) => item.address ?? 'native').sort().join();
    if (wrapped && ids(sent) === 'native' && ids(received) === wrapped) kind = 'wrap';
    else if (wrapped && ids(sent) === wrapped && ids(received) === 'native') kind = 'unwrap';
    else kind = ids(sent) === ids(received) ? 'other' : 'swap';
  } else if (sent.length) {
    kind = 'send';
    counterparty = [...new Set(outgoing.map((transfer) => transfer.to))].join(', ');
  } else {
    kind = received.length ? 'receive' : 'other';
    counterparty = [...new Set(incoming.map((transfer) => transfer.from))].join(', ') || undefined;
  }
  return { chainId, hash, timestamp: new Date(Math.max(...group.map((transfer) => transfer.timestamp)) * 1000).toISOString(), kind, sent, received, counterparty, source: 'alchemy' };
}

const usd = (legs: Leg[] | undefined) => (legs ?? []).reduce((total, item) => total + (item.valueUsd ?? 0), 0);
const priced = (legs: Leg[]) => legs.length > 0 && legs.every((item) => item.valueUsd !== undefined);

function summarize(activities: WalletActivity[]): HistorySummary {
  const summary: HistorySummary = { transactions: activities.length, byKind: {}, swapVolumeUsd: 0, swapCostUsd: 0, addedUsd: 0, removedUsd: 0, feesCollectedUsd: 0, gasUsd: 0 };
  for (const activity of activities) {
    summary.byKind[activity.kind] = (summary.byKind[activity.kind] ?? 0) + 1;
    summary.gasUsd += activity.gasUsd ?? 0;
    if (activity.kind === 'swap' && priced(activity.sent) && priced(activity.received)) {
      summary.swapVolumeUsd += usd(activity.sent);
      summary.swapCostUsd += usd(activity.sent) - usd(activity.received);
    }
    if (activity.kind === 'add-liquidity') summary.addedUsd += usd(activity.sent);
    if (activity.kind === 'remove-liquidity') summary.removedUsd += usd(activity.received);
    summary.feesCollectedUsd += activity.kind === 'collect-fees' ? usd(activity.received) : usd(activity.fees);
  }
  return summary;
}

/** USD value of a swap's or transfer's main side, for the table. */
export function activityValue(activity: WalletActivity): number | undefined {
  const legs = ['receive', 'remove-liquidity', 'collect-fees'].includes(activity.kind) ? activity.received : activity.sent;
  return priced(legs) ? usd(legs) : undefined;
}

/** Received minus sent, for swaps, wraps and unwraps whose sides are all priced: negative is what the trade cost. */
export function swapResult(activity: WalletActivity): number | undefined {
  return ['swap', 'wrap', 'unwrap'].includes(activity.kind) && priced(activity.sent) && priced(activity.received) ? usd(activity.received) - usd(activity.sent) : undefined;
}

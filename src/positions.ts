import { CHAINS, type EvmChainId, type LpPosition } from './types.js';
import type { RevertClient } from './providers/revert.js';
import type { RpcProvider } from './providers/rpc.js';
import { usdPrices } from './providers/prices.js';

export type PositionSource = 'auto' | 'revert' | 'rpc';

/** One address and the networks to read it on, with the saved wallet name for each network that has one. */
export interface WalletGroup { address: string; chains: EvmChainId[]; names?: Partial<Record<EvmChainId, string>> }

export interface PortfolioResult {
  positions: LpPosition[];
  /** Address/network pairs read successfully, for the saved wallets' last-checked time. */
  checked: Array<{ address: string; chainId: EvmChainId }>;
}

/**
 * Positions for every wallet group. Revert Finance (open and closed positions with full history) is tried first;
 * in auto mode a failure falls back to reading the NFTs the wallet holds over RPC, which has no history.
 * Problems are reported as they happen; fails only when no wallet/network could be read at all.
 */
export async function loadPortfolio(groups: WalletGroup[], source: PositionSource, clients: { revert: RevertClient; rpc: RpcProvider; pricesUrl?: string }, report: (message: string) => void, options: { events?: boolean } = {}): Promise<PortfolioResult> {
  const result: PortfolioResult = { positions: [], checked: [] };
  const fromRpc: LpPosition[] = [];
  let attempts = 0;
  let failures = 0;
  await Promise.all(groups.map(async (group) => {
    const names = [...new Set(Object.values(group.names ?? {}))];
    const label = names.length ? `${names.join(', ')} (${group.address})` : group.address;
    if (source !== 'rpc') {
      attempts += 1;
      try {
        const found = await clients.revert.listPositions(group.address, group.chains, options);
        result.positions.push(...found.map((position) => ({ ...position, walletName: group.names?.[position.chainId] })));
        group.chains.forEach((chainId) => result.checked.push({ address: group.address, chainId }));
        return;
      } catch (error) {
        failures += 1;
        if (source === 'revert') { report(`${label}: ${(error as Error).message}`); return; }
        report(`${label}: ${(error as Error).message} Showing on-chain data instead: position NFTs the wallet still holds, without deposit, fee and PnL history.`);
      }
    }
    await Promise.all(group.chains.map(async (chainId) => {
      attempts += 1;
      try {
        const found = await clients.rpc.portfolio(group.address, chainId);
        fromRpc.push(...found.map((position) => ({ ...position, walletName: group.names?.[position.chainId] })));
        result.checked.push({ address: group.address, chainId });
      } catch (error) {
        failures += 1;
        report(`${label} on ${CHAINS[chainId].name}: ${(error as Error).message}`);
      }
    }));
  }));
  // Every Revert lookup and every RPC fallback failed: nothing to show.
  if (attempts && !result.checked.length) {
    throw new Error(source === 'revert' ? 'Revert Finance could not be reached for any wallet; see the messages above. Retry, or add --source rpc for on-chain data.'
      : 'Positions could not be read for any wallet/network; see the messages above. Public RPCs may be busy: retry, or configure an RPC_URL_* endpoint.');
  }
  if (fromRpc.length) result.positions.push(...await priced(fromRpc, clients.pricesUrl, report));
  return result;
}

/** Add USD prices, values and fee values to on-chain positions; without prices the USD columns stay empty. */
async function priced(positions: LpPosition[], endpoint: string | undefined, report: (message: string) => void): Promise<LpPosition[]> {
  let prices = new Map<string, number>();
  try {
    prices = await usdPrices(positions.flatMap((position) => [position.token0, position.token1].map((token) => ({ chainId: position.chainId, address: token.address }))), { endpoint });
  } catch (error) {
    report(`USD values are unavailable: ${(error as Error).message}`);
  }
  return positions.map((position) => {
    const price0 = prices.get(`${position.chainId}:${position.token0.address.toLowerCase()}`);
    const price1 = prices.get(`${position.chainId}:${position.token1.address.toLowerCase()}`);
    const usd = (amount0: number | undefined, amount1: number | undefined) =>
      amount0 === undefined || amount1 === undefined || price0 === undefined || price1 === undefined ? undefined : amount0 * price0 + amount1 * price1;
    return {
      ...position,
      token0: { ...position.token0, priceUsd: price0 }, token1: { ...position.token1, priceUsd: price1 },
      valueUsd: usd(position.amount0, position.amount1), uncollectedFeesUsd: usd(position.uncollectedFees0, position.uncollectedFees1),
    };
  });
}

/** Open positions by value, highest first; closed ones most recently closed first. */
export function splitPositions(positions: LpPosition[]): { active: LpPosition[]; past: LpPosition[] } {
  const time = (value: string | undefined) => value ? Date.parse(value) : 0;
  return {
    active: positions.filter((position) => position.active).sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)),
    past: positions.filter((position) => !position.active).sort((a, b) => time(b.closedAt ?? b.openedAt) - time(a.closedAt ?? a.openedAt) || Number(b.id) - Number(a.id)),
  };
}

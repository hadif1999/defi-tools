import { DEFAULT_API_URL, parseChains } from '../config.js';
import { analyzePosition, buildAlerts } from '../analytics.js';
import type { Store } from '../storage.js';
import { UniswapApiClient } from '../providers/uniswap-api.js';
import { RpcProvider } from '../providers/rpc.js';
import { CHAINS, isEvmChain, type Alert, type AppConfig, type EvmChainId, type Pool, type PositionAnalysis, type Protocol } from '../types.js';
import { walletTargets, type Report } from './wallets.js';

// positions analyze and alerts check: range status over RPC, and new alerts saved to the database.

export interface RangeCheckRequest {
  /** Saved wallet names or addresses, comma-separated, or all. */
  wallet?: string;
  chain?: string;
  protocol: Protocol;
  /** NFT IDs, comma-separated. */
  position?: string;
  source?: 'public' | 'custom';
  apiUrl?: string;
}

export interface RangeCheckResult {
  analyses: PositionAnalysis[];
  /** alerts mode: alerts not seen before, now saved. */
  fresh: Alert[];
  /** Positions whose range status could not be read. */
  unknown: number;
}

export function dataSource(options: { source?: 'public' | 'custom'; apiUrl?: string }, config: AppConfig): 'public' | 'custom' {
  return options.source ?? ((options.apiUrl ?? config.apiUrl) !== DEFAULT_API_URL ? 'custom' : 'public');
}

export async function checkPositions(request: RangeCheckRequest, mode: 'analyze' | 'alerts', { config, store, report, quiet }: { config: AppConfig; store: Store; report: Report; quiet?: boolean }): Promise<RangeCheckResult> {
  // Positions are Uniswap NFTs on EVM chains; Solana (Raydium) is for pool listings only.
  const targets = walletTargets(request.wallet, parseChains(request.chain), config, store, { report, quiet });
  if (!targets.length) throw new Error('No wallets saved. Run defi-tool wallet add 0xYourAddress --chain eth, or pass --wallet 0xYourAddress.');
  const checks = targets.filter((target) => isEvmChain(target.chainId));
  if (!checks.length) throw new Error('Positions are read for Uniswap on EVM chains only, not Solana. Choose an EVM wallet or --chain, e.g. --chain eth.');
  if (checks.length < targets.length) report('Note: skipping Solana; positions are read for Uniswap on EVM chains only.');
  const source = dataSource(request, config);
  const ids: string[] | undefined = request.position === undefined ? undefined : request.position.split(',').map((id) => id.trim());
  if (ids && (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id) || BigInt(id) >= 2n ** 256n))) throw new Error('--position must contain unsigned NFT IDs, e.g. --position 123,456.');
  if (ids && checks.length !== 1) throw new Error('--position requires one --wallet and one --chain so NFT IDs are unambiguous.');
  if (ids && source === 'custom') throw new Error('--position is for direct RPC reads; add --source public.');
  if (source === 'public' && request.protocol === 'v4' && !ids) throw new Error('Public v4 wallet discovery needs an indexer. Use --position <NFT IDs> with one --wallet and one --chain, without an API key.');
  const api = new UniswapApiClient({ endpoint: request.apiUrl ?? config.apiUrl, apiKey: config.apiKey });
  const rpc = new RpcProvider(config.rpcUrls);
  let failures = 0;
  const analyses: PositionAnalysis[] = [];
  for (const { address: wallet, chainId } of checks) {
    const chain = chainId as EvmChainId;
    try {
      const found = source === 'public' ? await rpc.listPositions(wallet, chain, request.protocol, ids) : await api.listPositions(wallet, chain, request.protocol);
      for (const position of found) {
        const pool: Pool = { id: position.poolId, chainId: chain, protocol: position.protocol, token0: { address: '', symbol: '?', decimals: 18 }, token1: { address: '', symbol: '?', decimals: 18 }, source: 'uniswap-api', observedAt: new Date().toISOString() };
        analyses.push(analyzePosition(position, position.currentTick ?? await rpc.currentTick(pool), config.saturationThresholdPct));
      }
    } catch (error) {
      failures += 1;
      report(`${wallet} on ${CHAINS[chain].name}: ${(error as Error).message}`);
    }
  }
  if (failures === checks.length) throw new Error(source === 'public' ? 'Position RPC reads failed for every wallet/network. Public RPCs may be busy; retry or configure an RPC_URL_* endpoint. No Uniswap API key is needed.' : 'Custom position discovery failed for every wallet/network. Check your provider endpoint and access settings.');
  store.savePositions(analyses);
  let fresh: Alert[] = [];
  if (mode === 'alerts') {
    fresh = buildAlerts(analyses, new Map()).filter((alert) => !store.hasAlert(alert.fingerprint));
    fresh.forEach((alert) => store.saveAlert(alert));
  }
  return { analyses, fresh, unknown: analyses.filter((analysis) => analysis.status === 'unknown').length };
}

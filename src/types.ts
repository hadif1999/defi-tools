export type Protocol = 'v3' | 'v4';

/**
 * Pool listings cover v2-v4 (Uniswap, PancakeSwap), clmm (concentrated: Raydium CLMM, Aerodrome Slipstream) and
 * amm (standard: Raydium AMM, Aerodrome basic, Curve); position reads support only Uniswap v3 and v4.
 */
export const POOL_VERSIONS = ['v2', 'v3', 'v4', 'clmm', 'amm'] as const;
export type PoolVersion = typeof POOL_VERSIONS[number];

/** Exchanges whose pools are listed, as --dex takes them. */
export const DEXES = ['uniswap', 'pancakeswap', 'aerodrome', 'curve', 'raydium'] as const;
export type Dex = typeof DEXES[number];

export const POOL_SORTS = ['tvl', 'volume', 'apr', 'vol-tvl'] as const;
export type PoolSort = typeof POOL_SORTS[number];

/** Solana has no EVM chain ID; 501 is the placeholder some wallets use. It lists Raydium pools only (no positions, no RPC). */
export const SOLANA = 501;
export type EvmChainId = 1 | 10 | 56 | 137 | 4663 | 8453 | 42161;
export type ChainId = EvmChainId | typeof SOLANA;
export const isEvmChain = (chainId: ChainId): chainId is EvmChainId => chainId !== SOLANA;

// dexes: the exchanges the default source (DefiLlama) lists on each network; Robinhood Chain comes from GeckoTerminal.
export const CHAINS: Record<ChainId, { name: string; native: string; slug: string; aliases: string[]; dexes: string[] }> = {
  1: { name: 'Ethereum', native: 'ETH', slug: 'eth', aliases: ['ethereum', 'mainnet'], dexes: ['Uniswap', 'PancakeSwap', 'Curve'] },
  10: { name: 'Optimism', native: 'ETH', slug: 'op', aliases: ['optimism'], dexes: ['Uniswap', 'Curve'] },
  56: { name: 'BNB Chain', native: 'BNB', slug: 'bnb', aliases: ['bsc', 'binance'], dexes: ['Uniswap', 'PancakeSwap'] },
  137: { name: 'Polygon', native: 'POL', slug: 'polygon', aliases: ['matic', 'pol'], dexes: ['Uniswap', 'Curve'] },
  501: { name: 'Solana', native: 'SOL', slug: 'solana', aliases: ['sol'], dexes: ['Raydium'] },
  4663: { name: 'Robinhood Chain', native: 'ETH', slug: 'robinhood', aliases: ['robinhood-chain', 'rh'], dexes: ['Uniswap'] },
  8453: { name: 'Base', native: 'ETH', slug: 'base', aliases: [], dexes: ['Uniswap', 'PancakeSwap', 'Aerodrome', 'Curve'] },
  42161: { name: 'Arbitrum', native: 'ETH', slug: 'arb', aliases: ['arbitrum'], dexes: ['Uniswap', 'PancakeSwap', 'Curve'] },
};

export interface Pool {
  id: string;
  chainId: ChainId;
  protocol: PoolVersion;
  /** Exchange the pool trades on: "Uniswap", "PancakeSwap", "Aerodrome", "Curve" or "Raydium"; missing means Uniswap. */
  dex?: string;
  /** Pool contract address when known; for some sources id is a provider-specific key instead. */
  address?: string;
  /** When the pool was created (ISO 8601). */
  createdAt?: string;
  /** Swaps in the last 24h. */
  txCount24h?: number;
  /** Display name such as "WETH/USDC" when the source provides one. */
  name?: string;
  token0: { address: string; symbol: string; decimals?: number };
  token1: { address: string; symbol: string; decimals?: number };
  /** Every token, for pools holding more than two (Curve's DAI/USDC/USDT); token0 and token1 are the first two. */
  tokens?: Array<{ address: string; symbol: string }>;
  /** Swap fee in hundredths of a basis point, as Uniswap encodes it: 3000 = 0.3%. */
  feeTier?: number;
  /** Fee description when no exact tier is known, e.g. "dynamic" or "<0.01%". */
  feeLabel?: string;
  tickSpacing?: number;
  hook?: string;
  tvlUsd?: number;
  volume24hUsd?: number;
  volume7dUsd?: number;
  fees24hUsd?: number;
  /** Annualized fee APR from the last 24h, in percent, before Uniswap's protocol fee. */
  aprPct?: number;
  volatility24hPct?: number;
  price?: number;
  tick?: number;
  liquidity?: string;
  source: 'uniswap-api' | 'rpc' | 'mixed' | 'geckoterminal' | 'defillama';
  observedAt: string;
}

export interface Position {
  id: string;
  wallet: string;
  poolId: string;
  chainId: ChainId;
  protocol: Protocol;
  lowerTick?: number;
  upperTick?: number;
  currentTick?: number;
  liquidity?: string;
  amount0?: string;
  amount1?: string;
  valueUsd?: number;
  source: 'uniswap-api' | 'rpc' | 'mixed' | 'revert';
}

export type RangeStatus =
  | 'in_range'
  | 'near_lower'
  | 'near_upper'
  | 'out_of_range_below'
  | 'out_of_range_above'
  | 'unknown';

export interface PositionAnalysis extends Position {
  currentTick?: number;
  status: RangeStatus;
  distanceToBoundaryPct?: number;
  reason: string;
}

export interface PoolScore {
  pool: Pool;
  score: number;
  confidence: number;
  components: {
    feeQuality: number;
    liquidityQuality: number;
    utilization: number;
    volatilityRisk: number;
    concentrationRisk: number;
  };
  reasons: string[];
}

export type AlertType =
  | 'near_boundary'
  | 'out_of_range'
  | 'recovered'
  | 'stale_data';

export interface Alert {
  fingerprint: string;
  type: AlertType;
  wallet: string;
  positionId: string;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

/** A Uniswap LP position for positions list: live state for open positions and the full history for closed ones. */
export interface LpPosition {
  /** NFT token ID. */
  id: string;
  chainId: EvmChainId;
  dex: string;
  protocol: Protocol;
  wallet: string;
  /** Saved wallet name, when the wallet was given by name or is saved. */
  walletName?: string;
  /** Pool contract address (v3) or pool ID (v4). */
  pool?: string;
  token0: { address: string; symbol: string; decimals?: number; priceUsd?: number };
  token1: { address: string; symbol: string; decimals?: number; priceUsd?: number };
  /** Fee in hundredths of a basis point: 500 = 0.05%. */
  feeTier?: number;
  tickLower: number;
  tickUpper: number;
  /** Prices are token1 per token0, decimals applied. */
  priceLower?: number;
  priceUpper?: number;
  price?: number;
  /** Pool price at the last withdrawal of a closed position, token1 per token0. */
  exitPrice?: number;
  currentTick?: number;
  liquidity: string;
  /** Open: liquidity is still provided. Closed positions have withdrawn all liquidity (the NFT may remain). */
  active: boolean;
  inRange?: boolean;
  amount0?: number;
  amount1?: number;
  valueUsd?: number;
  uncollectedFees0?: number;
  uncollectedFees1?: number;
  uncollectedFeesUsd?: number;
  /** Fees earned over the position's life, collected and uncollected, in USD. */
  feesEarnedUsd?: number;
  depositedUsd?: number;
  withdrawnUsd?: number;
  /** Transaction fees paid for the position's mint, changes and collects, in USD. */
  gasUsd?: number;
  /** Profit or loss in USD: value now + withdrawals + fees earned − deposits − gas, each valued when it happened. */
  pnlUsd?: number;
  /** Impermanent loss in USD, fees excluded: the tokens the position returned minus the tokens deposited, at the exit prices (closed) or today's (open). */
  ilUsd?: number;
  /** Fees earned / deposits, annualized over the time held, in percent. */
  feeAprPct?: number;
  /** PnL / deposits, annualized over the time held, in percent. */
  totalAprPct?: number;
  openedAt?: string;
  closedAt?: string;
  source: 'revert' | 'rpc';
  /** False when deposits, withdrawals and collected fees are unknown (on-chain fallback). */
  historyAvailable: boolean;
}

/** A wallet saved with defi-tool wallet add. EVM addresses are stored lowercase; Solana addresses keep their case. */
export interface SavedWallet {
  name: string;
  address: string;
  chainId: ChainId;
  createdAt: string;
  updatedAt: string;
}

/** One token moving in or out of a wallet in a transaction; amounts have decimals applied. */
export interface Leg { symbol: string; /** Token contract; absent for the native coin. */ address?: string; amount: number; valueUsd?: number }

export const ACTIVITY_KINDS = ['swap', 'add-liquidity', 'remove-liquidity', 'collect-fees', 'send', 'receive', 'wrap', 'unwrap', 'other'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];

/** One wallet transaction for wallet history: what moved, valued at the time it happened. */
export interface WalletActivity {
  chainId: EvmChainId;
  hash: string;
  timestamp: string;
  kind: ActivityKind;
  sent: Leg[];
  received: Leg[];
  /** LP fees collected in the transaction (also when liquidity was removed at the same time). */
  fees?: Leg[];
  /** The other address for sends and receives. */
  counterparty?: string;
  positionId?: string;
  /** "WETH/USDC 0.05% v3" for liquidity transactions. */
  pool?: string;
  /** Fee the wallet paid to send the transaction, in the native coin and USD; absent when another address sent it. */
  gasNative?: number;
  gasUsd?: number;
  /** Received only unknown, unpriced tokens: most likely an unsolicited airdrop. */
  spam?: boolean;
  source: 'revert' | 'alchemy';
  explorerUrl?: string;
}

export interface AppConfig {
  apiUrl: string;
  apiKey?: string;
  /** Alchemy key for wallet history (swaps and transfers); never sent anywhere but Alchemy. */
  alchemyApiKey?: string;
  rpcUrls: Partial<Record<ChainId, string>>;
  chains: ChainId[];
  wallets: string[];
  databasePath: string;
  saturationThresholdPct: number;
  dataTtlSeconds: number;
}

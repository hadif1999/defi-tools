import { formatUnits, parseAbi, type Address } from 'viem';
import { CHAINS, isEvmChain, type SavedWallet } from '../types.js';
import type { RpcProvider } from './rpc.js';
import { assetPriceKey, coinPrices } from './prices.js';
import { knownTokens } from './tokens.js';

// Solana's public RPC (no key); getBalance returns lamports.
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);

export interface Holding { symbol: string; amount: number; valueUsd?: number }
/** What a wallet holds now: its native coin and any well-known tokens with a balance, valued in USD where prices exist. */
export interface WalletBalance { holdings: Holding[]; valueUsd?: number }

/**
 * Balances for saved wallets, keyed by wallet name. EVM wallets: the native coin plus the well-known tokens of
 * positions create (Base and Arbitrum); Solana wallets: SOL only. A wallet that cannot be read maps to its Error.
 * Prices come from DefiLlama in one request; without them amounts still show and the USD value is left out.
 */
export async function walletBalances(wallets: SavedWallet[], rpc: RpcProvider, options: { solanaRpcUrl?: string; pricesUrl?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, WalletBalance | Error>> {
  const read = await Promise.all(wallets.map(async (wallet) => {
    try { return await holdings(wallet, rpc, options); } catch (error) { return error as Error; }
  }));
  const keys = read.flatMap((result) => result instanceof Error ? [] : result.map((holding) => holding.priceKey));
  const prices = keys.length ? await coinPrices(keys, { endpoint: options.pricesUrl, fetcher: options.fetcher }).catch(() => new Map<string, number>()) : new Map<string, number>();
  return new Map(wallets.map((wallet, index): [string, WalletBalance | Error] => {
    const result = read[index]!;
    if (result instanceof Error) return [wallet.name, result];
    const valued = result.map(({ symbol, amount, priceKey: key }) => ({ symbol, amount, valueUsd: prices.has(key) ? amount * prices.get(key)! : undefined }));
    const known = valued.filter((holding) => holding.valueUsd !== undefined);
    return [wallet.name, { holdings: valued, valueUsd: known.length ? known.reduce((total, holding) => total + holding.valueUsd!, 0) : undefined }];
  }));
}

async function holdings(wallet: SavedWallet, rpc: RpcProvider, options: { solanaRpcUrl?: string; fetcher?: typeof fetch }): Promise<Array<{ symbol: string; amount: number; priceKey: string }>> {
  const native = CHAINS[wallet.chainId].native;
  if (!isEvmChain(wallet.chainId)) {
    const response = await (options.fetcher ?? fetch)(options.solanaRpcUrl ?? SOLANA_RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [wallet.address] }),
    });
    const body = await response.json().catch(() => ({})) as { result?: { value?: unknown }; error?: { message?: string } };
    if (typeof body.result?.value !== 'number') throw new Error(`Solana RPC: ${body.error?.message ?? `HTTP ${response.status}`}`);
    return [{ symbol: native, amount: body.result.value / 1e9, priceKey: 'coingecko:solana' }];
  }
  const chainId = wallet.chainId;
  const client = rpc.client(chainId);
  const owner = wallet.address as Address;
  const tokens = await Promise.all(knownTokens(chainId).map(async (address) => {
    const balance = await client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    if (balance === 0n) return [];
    const [symbol, decimals] = await Promise.all([client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'symbol' }), client.readContract({ address: address as Address, abi: erc20Abi, functionName: 'decimals' })]);
    return [{ symbol, amount: Number(formatUnits(balance, decimals)), priceKey: assetPriceKey(chainId, address) }];
  }));
  const coin = await client.getBalance({ address: owner });
  return [{ symbol: native, amount: Number(formatUnits(coin, 18)), priceKey: assetPriceKey(chainId) }, ...tokens.flat()];
}

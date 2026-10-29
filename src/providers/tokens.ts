import type { EvmChainId } from '../types.js';

/**
 * Well-known tokens by symbol, so positions create can take WETH/USDC instead of addresses. Any token can still be
 * given by address. The symbol each contract reports is checked on-chain before a transaction is built.
 */
const TOKENS: Partial<Record<EvmChainId, Record<string, string>>> = {
  8453: {
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    usdbc: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
    dai: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    cbbtc: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    cbeth: '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22',
    wsteth: '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452',
    aero: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
  },
  42161: {
    weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    'usdc.e': '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    usdt: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    dai: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    wbtc: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    wsteth: '0x5979d7b546e38e414f7e9822514be443a4800529',
    arb: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  },
};

/** Networks positions create supports for now. */
export const CREATE_CHAINS: readonly EvmChainId[] = [8453, 42161];

/** A token address from a symbol (ETH means WETH) or an address; undefined when the symbol is not known on that network. */
export function tokenAddress(chainId: EvmChainId, query: string): string | undefined {
  const value = query.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(value)) return value;
  return TOKENS[chainId]?.[value === 'eth' ? 'weth' : value];
}

/** Symbols known on a network, for error messages. */
export const knownSymbols = (chainId: EvmChainId): string[] => Object.keys(TOKENS[chainId] ?? {}).map((symbol) => symbol.toUpperCase());

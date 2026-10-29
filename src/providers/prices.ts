import type { EvmChainId } from '../types.js';
import { getJson, positive } from './http.js';

// DefiLlama's public coins API (no key): current USD prices by chain:address. https://defillama.com/docs/api
export const PRICES_URL = 'https://coins.llama.fi';
const chainNames: Record<EvmChainId, string> = { 1: 'ethereum', 10: 'optimism', 56: 'bsc', 137: 'polygon', 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' };
const BATCH = 50;

/** Current USD prices keyed by "chainId:lowercase address"; tokens without a price are absent. */
export async function usdPrices(tokens: Array<{ chainId: EvmChainId; address: string }>, options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number>> {
  const keys = [...new Set(tokens.map((token) => `${chainNames[token.chainId]}:${token.address.toLowerCase()}`))];
  const prices = new Map<string, number>();
  for (let start = 0; start < keys.length; start += BATCH) {
    const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/prices/current/${keys.slice(start, start + BATCH).join(',')}`;
    const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { price?: unknown }> } | null;
    for (const [key, coin] of Object.entries(body?.coins ?? {})) {
      const [chain, address] = key.split(':');
      const chainId = Object.entries(chainNames).find(([, name]) => name === chain)?.[0];
      const price = positive(coin?.price);
      if (chainId && address && price !== undefined) prices.set(`${chainId}:${address.toLowerCase()}`, price);
    }
  }
  return prices;
}

/** Daily USD prices over the last `days` days, oldest first, keyed like usdPrices; tokens without history are absent. */
export async function dailyPrices(tokens: Array<{ chainId: EvmChainId; address: string }>, days: number, options: { endpoint?: string; fetcher?: typeof fetch } = {}): Promise<Map<string, number[]>> {
  const keys = [...new Set(tokens.map((token) => `${chainNames[token.chainId]}:${token.address.toLowerCase()}`))];
  const url = `${(options.endpoint ?? PRICES_URL).replace(/\/$/, '')}/chart/${keys.join(',')}?span=${days + 1}&period=1d`;
  const body = await getJson(options.fetcher ?? fetch, url, 'DefiLlama prices', 20_000) as { coins?: Record<string, { prices?: Array<{ timestamp?: unknown; price?: unknown }> }> } | null;
  const history = new Map<string, number[]>();
  for (const [key, coin] of Object.entries(body?.coins ?? {})) {
    const [chain, address] = key.split(':');
    const chainId = Object.entries(chainNames).find(([, name]) => name === chain)?.[0];
    const prices = (coin?.prices ?? []).map((point) => positive(point.price)).filter((price): price is number => price !== undefined);
    if (chainId && address && prices.length) history.set(`${chainId}:${address.toLowerCase()}`, prices);
  }
  return history;
}

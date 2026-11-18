import { z } from 'zod';
import { getJson, retryRateLimit } from './http.js';

// CoinGecko's public API (no key), used only to turn a symbol such as ETH into a coin ID. https://docs.coingecko.com/
export const COINGECKO_URL = 'https://api.coingecko.com/api/v3';

const searchSchema = z.object({
  coins: z.array(z.object({ id: z.string(), symbol: z.string(), name: z.string().optional(), market_cap_rank: z.number().nullish() })),
});

export interface CoinMatch { id: string; symbol: string; name?: string; rank?: number }

/** Coins whose name or symbol matches the query, as CoinGecko's search ranks them. A rate limit waits and retries. */
export async function searchCoins(query: string, options: { endpoint?: string; fetcher?: typeof fetch; rateLimitWaitMs?: number } = {}): Promise<CoinMatch[]> {
  const url = new URL(`${(options.endpoint ?? COINGECKO_URL).replace(/\/$/, '')}/search`);
  url.searchParams.set('query', query);
  const body = await retryRateLimit(() => getJson(options.fetcher ?? fetch, url.href, 'CoinGecko', 20_000), options.rateLimitWaitMs ?? 15_000);
  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) throw new Error('Malformed CoinGecko search response.');
  return parsed.data.coins.map((coin) => ({ id: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.market_cap_rank ?? undefined }));
}

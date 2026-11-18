/**
 * GET a JSON document (or POST one, when a body is given, as for JSON-RPC), turning network failures into messages that
 * name the service and suggest a next step. Connection failures and 5xx responses are retried once; rate limits (429) are not.
 * Messages name only the host, so keys in the URL path never appear in them.
 */
export async function getJson(fetcher: typeof fetch, url: string, name: string, timeoutMs: number, retryDelayMs = 1_000, body?: unknown): Promise<unknown> {
  const service = `${name} (${new URL(url).host})`;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetcher(url, body === undefined
        ? { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }
        : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500 || attempt === 2) break;
    } catch (error) {
      const kind = (error as Error).name;
      if (kind === 'TimeoutError' || kind === 'AbortError') throw new Error(`${service} did not respond within ${timeoutMs / 1000}s. Check your connection and retry.`);
      if (attempt === 2) {
        const cause = ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;
        throw new Error(`Could not reach ${service}: ${cause}. Check your internet connection or proxy settings.`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (!response!.ok) {
    const hint = response!.status === 429 ? ' Public rate limit reached; wait a minute and retry with fewer chains or a smaller --top.' : response!.status >= 500 ? ' The service is having problems; retry shortly.' : '';
    throw new Error(`${service} returned HTTP ${response!.status}.${hint}`);
  }
  try {
    return await response!.json();
  } catch {
    throw new Error(`${service} returned a response that is not valid JSON.`);
  }
}

/** Parse a finite number from a JSON number or numeric string. */
export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '' || !['number', 'string'].includes(typeof value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
export function nonnegative(value: unknown): number | undefined { const number = finite(value); return number !== undefined && number >= 0 ? number : undefined; }
export function positive(value: unknown): number | undefined { const number = finite(value); return number !== undefined && number > 0 ? number : undefined; }

/** Convert a percentage label such as "0.3%" or "0.05%" to Uniswap fee units (3000, 500); undefined when below label precision. */
export function feeTierFromPercent(label: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(label);
  if (!match) return undefined;
  const pips = Math.round(Number(match[1]) * 10_000);
  return pips > 0 && pips < 1_000_000 ? pips : undefined;
}

/** Run a request, and again after a rate limit (HTTP 429): wait `waitMs`, then twice as long each time, up to `retries` times. */
export async function retryRateLimit<T>(task: () => Promise<T>, waitMs: number, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!/HTTP 429/.test((error as Error).message) || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs * 2 ** attempt));
    }
  }
}

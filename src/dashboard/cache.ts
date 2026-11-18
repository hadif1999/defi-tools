// A small TTL cache for slow upstream reads (Revert Finance, DefiLlama's 10 MB yields file, RPC balances). Identical
// requests that arrive while one is in flight share it; failures are not cached.

interface Entry<T> { value?: T; expires: number; pending?: Promise<T>; storedAt: number }

export interface Cached<T> { value: T; cachedAt: string; cached: boolean }

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(private readonly maxEntries = 500, private readonly clock = () => Date.now()) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>, options: { refresh?: boolean } = {}): Promise<Cached<T>> {
    const now = this.clock();
    const entry = this.entries.get(key) as Entry<T> | undefined;
    if (entry?.pending) return { value: await entry.pending, cachedAt: new Date(this.clock()).toISOString(), cached: false };
    if (!options.refresh && entry && entry.value !== undefined && entry.expires > now) {
      return { value: entry.value, cachedAt: new Date(entry.storedAt).toISOString(), cached: true };
    }
    const pending = load();
    this.entries.set(key, { ...entry, pending, expires: entry?.expires ?? 0, storedAt: entry?.storedAt ?? now });
    try {
      const value = await pending;
      const storedAt = this.clock();
      this.entries.set(key, { value, expires: storedAt + ttlMs, storedAt });
      this.trim();
      return { value, cachedAt: new Date(storedAt).toISOString(), cached: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  /** Drop entries whose key starts with a prefix (after a write that makes them stale), or everything. */
  invalidate(prefix = ''): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.clock();
    for (const [key, entry] of this.entries) if (!entry.pending && entry.expires <= now) this.entries.delete(key);
    // Still too many: drop the oldest (Map keeps insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      if (!this.entries.get(key)!.pending) this.entries.delete(key);
    }
  }
}

/** Default lifetimes, in milliseconds. */
export const TTL = {
  pools: 5 * 60_000,
  positions: 60_000,
  detail: 2 * 60_000,
  balances: 60_000,
  history: 5 * 60_000,
  chart: 60_000,
  market: 5 * 60_000,
  ticker: 10_000,
} as const;

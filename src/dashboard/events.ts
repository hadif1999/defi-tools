import type { ServerResponse } from 'node:http';
import { TickerFeed, tickerJson } from '../dex-ticker.js';
import type { GeckoTerminalClient } from '../providers/geckoterminal.js';
import { CHAINS, type ChainId } from '../types.js';

// Server-sent events for the dashboard: live pool tickers, job progress, and a heartbeat. Ticker feeds are shared:
// one GeckoTerminal feed per pool and price unit however many pages watch it, stopped when the last page leaves.
// Every feed uses the same GeckoTerminal client, which spaces requests to stay within the public limit (about 30 a
// minute); the update interval also grows with the number of pools watched.

export interface TickerKey { chainId: ChainId; address: string; quote: string }

/** "8453:0xd0b5…:auto" — the pool on a chain and the price unit it is quoted in. */
export function tickerKey(key: TickerKey): string { return `${key.chainId}:${key.address.toLowerCase()}:${key.quote.toLowerCase()}`; }

export function parseTickerKey(text: string): TickerKey {
  const [chain, address, quote = 'auto', ...rest] = text.split(':');
  const chainId = Number(chain) as ChainId;
  if (rest.length || !(chainId in CHAINS) || !address || !/^[A-Za-z0-9]{20,80}$/.test(address) || !/^[A-Za-z0-9]{1,64}$/.test(quote)) {
    throw new Error(`"${text}" is not a ticker key: use chainId:poolAddress[:quote], e.g. 8453:0xd0b53d9277642d899df5c87a3966a349a798f224:auto.`);
  }
  return { chainId, address: address.toLowerCase(), quote: quote.toLowerCase() };
}

interface Client { id: number; res: ServerResponse; tickers: Set<string> }

interface Feed {
  key: TickerKey;
  feed?: TickerFeed;
  subscribers: Set<number>;
  timer?: NodeJS.Timeout;
  last?: object;
  lastError?: string;
  failures: number;
  busy: boolean;
}

export const MAX_TICKERS = 12;

export class EventHub {
  private readonly clients = new Map<number, Client>();
  private readonly feeds = new Map<string, Feed>();
  private nextId = 1;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly gecko: GeckoTerminalClient | undefined, private readonly baseIntervalMs = 15_000) {
    this.heartbeat = setInterval(() => this.broadcast('ping', { at: new Date().toISOString() }), 15_000);
    this.heartbeat.unref();
  }

  /** Attach a page's event stream; it receives job events and the tickers it asked for. */
  connect(res: ServerResponse, tickers: string[]): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\n\n');
    const client: Client = { id: this.nextId++, res, tickers: new Set() };
    this.clients.set(client.id, client);
    this.send(client, 'hello', { tickers: tickers.length, offline: !this.gecko });
    for (const text of tickers.slice(0, MAX_TICKERS)) {
      let key: TickerKey;
      try { key = parseTickerKey(text); } catch (error) { this.send(client, 'ticker-error', { key: text, message: (error as Error).message }); continue; }
      this.subscribe(client, key);
    }
    if (tickers.length > MAX_TICKERS) this.send(client, 'notice', { message: `Only the first ${MAX_TICKERS} tickers are streamed live, to stay within GeckoTerminal's rate limit.` });
    res.on('close', () => this.disconnect(client.id));
  }

  /** Send to every page. */
  broadcast(event: string, data: unknown): void {
    for (const client of this.clients.values()) this.send(client, event, data);
  }

  get stats(): { clients: number; feeds: number } { return { clients: this.clients.size, feeds: this.feeds.size }; }

  close(): void {
    clearInterval(this.heartbeat);
    for (const feed of this.feeds.values()) clearTimeout(feed.timer);
    this.feeds.clear();
    for (const client of this.clients.values()) client.res.end();
    this.clients.clear();
  }

  private send(client: Client, event: string, data: unknown): void {
    if (client.res.writableEnded) return;
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private subscribe(client: Client, key: TickerKey): void {
    const id = tickerKey(key);
    client.tickers.add(id);
    let feed = this.feeds.get(id);
    if (!feed) {
      feed = { key, subscribers: new Set(), failures: 0, busy: false };
      this.feeds.set(id, feed);
    }
    feed.subscribers.add(client.id);
    if (feed.last) this.send(client, 'ticker', { key: id, ticker: feed.last });
    else if (feed.lastError) this.send(client, 'ticker-error', { key: id, message: feed.lastError });
    if (!this.gecko) { this.send(client, 'ticker-error', { key: id, message: 'offline: live prices are off (--offline)' }); return; }
    if (!feed.timer && !feed.busy) this.schedule(id, feed, 0);
  }

  private disconnect(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    for (const id of client.tickers) {
      const feed = this.feeds.get(id);
      if (!feed) continue;
      feed.subscribers.delete(clientId);
      if (!feed.subscribers.size) { clearTimeout(feed.timer); this.feeds.delete(id); }
    }
  }

  /** Spread requests out: the more pools are watched, the longer between updates of each. */
  private interval(feed: Feed): number {
    const spread = Math.max(this.baseIntervalMs, this.feeds.size * 4_000);
    // Repeated failures back off, up to a minute.
    return feed.failures ? Math.min(60_000, spread * 2 ** Math.min(feed.failures, 3)) : spread;
  }

  private schedule(id: string, feed: Feed, delay: number): void {
    feed.timer = setTimeout(() => void this.tick(id, feed), delay);
    feed.timer.unref();
  }

  private async tick(id: string, feed: Feed): Promise<void> {
    feed.timer = undefined;
    if (this.feeds.get(id) !== feed || !this.gecko) return;
    feed.busy = true;
    try {
      feed.feed ??= new TickerFeed(this.gecko, await this.gecko.pool(feed.key.chainId, feed.key.address), feed.key.quote);
      const ticker = await feed.feed.read();
      feed.last = tickerJson(ticker);
      feed.lastError = undefined;
      feed.failures = 0;
      for (const clientId of feed.subscribers) { const client = this.clients.get(clientId); if (client) this.send(client, 'ticker', { key: id, ticker: feed.last }); }
    } catch (error) {
      feed.failures += 1;
      feed.lastError = (error as Error).message;
      for (const clientId of feed.subscribers) { const client = this.clients.get(clientId); if (client) this.send(client, 'ticker-error', { key: id, message: feed.lastError }); }
    } finally {
      feed.busy = false;
    }
    if (this.feeds.get(id) === feed) this.schedule(id, feed, this.interval(feed));
  }
}

import { CHAINS } from './types.js';
import { priceUnit } from './dex-data.js';
import type { GeckoPool, GeckoTerminalClient, GeckoToken } from './providers/geckoterminal.js';

// A live ticker for one DEX pool: price, 24h change, high, low, volume and liquidity, from GeckoTerminal (no key).

export interface Ticker {
  /** BASE/QUOTE as exchanges write it: the priced token, then the unit (WETH/USDC, or WETH/USD). */
  pair: string;
  pool: GeckoPool;
  /** "USDC per WETH" or "USD per WETH". */
  priceUnit: string;
  pricedToken: GeckoToken;
  quoteToken?: GeckoToken;
  price: number;
  /** Change from the price 24 hours ago, in percent. */
  change24hPct?: number;
  high24h?: number;
  low24h?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  trades24h?: number;
  /** When this price was read (ISO 8601). */
  updatedAt: string;
}

/** 24h statistics from the pool's 15-minute candles: the price a day ago, and the range since. */
export interface DayStats { reference?: number; high?: number; low?: number }

const DAY = 86_400;

/**
 * The 24h reference price, high and low from candles ([time, open, high, low, close, volume], newest first, as
 * GeckoTerminal sends them). The reference is the last close at or before 24 hours ago, or the oldest open within the
 * day when the pool has no older trade. Malformed rows are ignored.
 */
export function dayStats(rows: unknown[][], now: number): DayStats {
  const candles = rows.filter((row) => row.length >= 5 && row.slice(0, 5).every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)) as number[][];
  const since = now - DAY;
  const day = candles.filter((row) => row[0]! + 900 > since);
  const before = candles.filter((row) => row[0]! + 900 <= since).sort((a, b) => b[0]! - a[0]!)[0];
  const oldest = [...day].sort((a, b) => a[0]! - b[0]!)[0];
  return {
    reference: before?.[4] ?? oldest?.[1],
    high: day.length ? Math.max(...day.map((row) => row[2]!)) : undefined,
    low: day.length ? Math.min(...day.map((row) => row[3]!)) : undefined,
  };
}

/** The pool's current price in the unit --quote asks for, from the pool snapshot. */
export function currentPrice(pool: GeckoPool, unit: ReturnType<typeof priceUnit>): number | undefined {
  const pricedIsBase = unit.priced.address.toLowerCase() === pool.base.address.toLowerCase();
  const market = pool.market ?? {};
  if (unit.currency === 'usd') return pricedIsBase ? market.baseUsd : market.quoteUsd;
  return pricedIsBase ? market.baseInQuote : market.quoteInBase;
}

/**
 * Reads tickers for one pool. The pool snapshot (price, volume, liquidity) is fetched on every read; the candles behind
 * the 24h change, high and low only every `statsEveryMs`, since they move slowly and each request counts against
 * GeckoTerminal's limit of about 30 a minute. Between candle reads, the live price still widens the high and low.
 */
export class TickerFeed {
  private stats?: DayStats;
  private statsAt = 0;
  private readonly unit: ReturnType<typeof priceUnit>;

  private readonly pair: string;

  constructor(private readonly client: GeckoTerminalClient, private pool: GeckoPool, quote: string,
    private readonly statsEveryMs = 60_000, private readonly clock = () => Date.now()) {
    this.unit = priceUnit(pool, quote);
    this.pair = `${this.unit.priced.symbol}/${this.unit.quote?.symbol ?? 'USD'}`;
  }

  async read(): Promise<Ticker> {
    const pool = await this.client.pool(this.pool.chainId, this.pool.address);
    this.pool = pool;
    const price = currentPrice(pool, this.unit);
    if (price === undefined) throw new Error(`GeckoTerminal has no current price for ${pool.name} on ${CHAINS[pool.chainId].name}.`);
    const now = this.clock();
    if (!this.stats || now - this.statsAt >= this.statsEveryMs) {
      // A failed candle read keeps the previous statistics; the price itself is what matters most.
      try {
        const rows = await this.client.ohlcv(pool.chainId, pool.address, '15m', { token: this.unit.priced.address, currency: this.unit.currency, limit: 97 });
        this.stats = dayStats(rows, Math.floor(now / 1000));
        this.statsAt = now;
      } catch {
        this.stats ??= {};
      }
    }
    const high = this.stats!.high === undefined ? undefined : Math.max(this.stats!.high, price);
    const low = this.stats!.low === undefined ? undefined : Math.min(this.stats!.low, price);
    return {
      pair: this.pair, pool, priceUnit: this.unit.label, pricedToken: this.unit.priced, quoteToken: this.unit.quote, price,
      change24hPct: this.stats!.reference ? (price / this.stats!.reference - 1) * 100 : undefined,
      high24h: high, low24h: low, volume24hUsd: pool.market?.volume24hUsd, liquidityUsd: pool.tvlUsd, trades24h: pool.market?.trades24h,
      updatedAt: new Date(now).toISOString(),
    };
  }
}

/** Parse a refresh interval: 10, 10s, 2m (seconds by default), at least 5 seconds so GeckoTerminal's limit holds. */
export function parseInterval(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m)?$/i.exec(value.trim());
  if (!match) throw new Error(`--interval "${value}" is not a duration. Use seconds (10, 10s) or minutes (1m).`);
  const seconds = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 60 : 1);
  if (seconds < 5) throw new Error('--interval must be at least 5s: GeckoTerminal allows about 30 requests a minute.');
  return seconds * 1000;
}

/** The ticker as JSON: stable field names, the pool by address, numbers unformatted. */
export function tickerJson(ticker: Ticker): object {
  const { pool } = ticker;
  return {
    pair: ticker.pair, chain: CHAINS[pool.chainId].slug, chainId: pool.chainId,
    pool: { address: pool.address, name: pool.name, dex: pool.dex, dexId: pool.dexId, version: pool.version, feeTier: pool.feeTier },
    priceUnit: ticker.priceUnit, price: ticker.price, change24hPct: ticker.change24hPct, high24h: ticker.high24h, low24h: ticker.low24h,
    volume24hUsd: ticker.volume24hUsd, liquidityUsd: ticker.liquidityUsd, trades24h: ticker.trades24h, updatedAt: ticker.updatedAt, source: 'geckoterminal',
  };
}

export interface WatchOptions {
  intervalMs: number;
  /** Stop after this many updates (attempts), like top -n; unlimited when undefined. */
  count?: number;
  json: boolean;
  color: boolean;
}

/** Where the watch loop writes and listens: the real terminal in the CLI, fakes in tests. */
export interface WatchIo {
  write: (text: string) => void;
  error: (text: string) => void;
  /** A terminal gets the full-screen view; anything else (a pipe, a file) gets one line per update. */
  tty: boolean;
  /** Keys typed while the screen is shown; q or Ctrl+C stops. */
  input?: NodeJS.ReadStream;
  render: (ticker: Ticker, previous: Ticker | undefined, status: { intervalMs: number; error?: string; color: boolean }) => string;
  line: (ticker: Ticker, color: boolean) => string;
}

const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
const LEAVE_SCREEN = '\x1b[?25h\x1b[?1049l';
const CLEAR = '\x1b[H\x1b[2J';

/**
 * Show the ticker until stopped. In a terminal, it takes over the screen (alternate buffer, cursor hidden), redraws
 * in place, and restores everything on q, Ctrl+C, SIGINT or SIGTERM. Elsewhere it prints a line, or a JSON object, per
 * update. A failed update keeps the last figures and retries, waiting longer after repeated failures (up to a minute).
 * Returns the number of successful updates.
 */
export async function watchTicker(feed: Pick<TickerFeed, 'read'>, options: WatchOptions, io: WatchIo): Promise<number> {
  const screen = io.tty && !options.json;
  const stop = new AbortController();
  const quit = () => stop.abort();
  const onKey = (data: Buffer) => { const key = data.toString(); if (key === 'q' || key === 'Q' || key === '\u0003') quit(); };
  let last: Ticker | undefined;
  let previous: Ticker | undefined;
  let lastError: string | undefined;
  const draw = () => {
    if (!screen) return;
    io.write(CLEAR + (last ? io.render(last, previous, { intervalMs: options.intervalMs, error: lastError, color: options.color })
      : `Waiting for the first price…${lastError ? `\n${lastError}` : ''}\nq or Ctrl+C to quit`));
  };
  const restore = () => { if (screen) io.write(LEAVE_SCREEN); };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  process.on('exit', restore);
  if (screen) {
    io.write(ENTER_SCREEN);
    process.stdout.on('resize', draw);
    if (io.input?.isTTY) { io.input.setRawMode(true); io.input.resume(); io.input.on('data', onKey); }
  }
  let successes = 0;
  let failures = 0;
  try {
    for (let attempt = 1; !stop.signal.aborted; attempt += 1) {
      try {
        const ticker = await feed.read();
        previous = last;
        last = ticker;
        lastError = undefined;
        failures = 0;
        successes += 1;
        if (screen) draw();
        else io.write(`${options.json ? JSON.stringify(tickerJson(ticker)) : io.line(ticker, options.color)}\n`);
      } catch (error) {
        failures += 1;
        lastError = (error as Error).message;
        if (screen) draw();
        else io.error(`${new Date().toISOString()} update failed: ${lastError}\n`);
      }
      if (options.count !== undefined && attempt >= options.count) break;
      const wait = Math.min(60_000, options.intervalMs * 2 ** Math.max(0, failures - 1));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        stop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  } finally {
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    process.off('exit', restore);
    if (screen) {
      process.stdout.off('resize', draw);
      if (io.input?.isTTY) { io.input.off('data', onKey); io.input.setRawMode(false); io.input.pause(); }
      restore();
      // Leave the latest figures in the normal screen, so they are not lost when the view closes.
      if (last) io.write(`${io.line(last, options.color)}\n`);
    }
  }
  return successes;
}

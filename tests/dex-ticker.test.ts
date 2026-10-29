import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentPrice, dayStats, parseInterval, TickerFeed, tickerJson, watchTicker, type Ticker, type WatchIo } from '../src/dex-ticker.js';
import { priceUnit } from '../src/dex-data.js';
import { formatTickerLine, renderTickerScreen } from '../src/output.js';
import type { GeckoPool, GeckoTerminalClient } from '../src/providers/geckoterminal.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = 1_793_300_000;
const POOL: GeckoPool = {
  chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', name: 'USDC / WETH 0.05%', dexId: 'uniswap-v3-base', dex: 'uniswap', version: 'v3', feeTier: 500,
  base: { address: USDC, symbol: 'USDC' }, quote: { address: WETH, symbol: 'WETH' }, tvlUsd: 8_300_000,
  market: { baseInQuote: 1 / 2_400, quoteInBase: 2_400, baseUsd: 1, quoteUsd: 2_401, volume24hUsd: 12_900_000, trades24h: 20_000 },
};
const candle = (time: number, open: number, high: number, low: number, close: number) => [time, open, high, low, close, 1_000];

test('24h figures: the reference is the last close a day ago; high and low cover the day', () => {
  const rows = [
    candle(NOW - 900, 2_390, 2_420, 2_380, 2_400),
    candle(NOW - 12 * 3_600, 2_300, 2_350, 2_250, 2_310),
    candle(NOW - 86_400 - 900, 2_200, 2_210, 2_190, 2_205), // Ended exactly 24h ago: the reference.
    candle(NOW - 2 * 86_400, 1_000, 9_999, 1, 1_500), // Older: ignored.
    [NOW - 3_600, 'x', 1, 1, 1, 1], // Malformed: ignored.
  ];
  assert.deepEqual(dayStats(rows, NOW), { reference: 2_205, high: 2_420, low: 2_250 });
  // A pool with no trade before the day starts from the oldest open in it.
  assert.deepEqual(dayStats(rows.slice(0, 2), NOW), { reference: 2_300, high: 2_420, low: 2_250 });
  assert.deepEqual(dayStats([], NOW), { reference: undefined, high: undefined, low: undefined });
});

test('the live price follows --quote, whichever way GeckoTerminal orders the tokens', () => {
  assert.equal(currentPrice(POOL, priceUnit(POOL, 'auto')), 2_400);
  assert.equal(currentPrice(POOL, priceUnit(POOL, 'usd')), 2_401);
  assert.equal(currentPrice(POOL, priceUnit(POOL, 'WETH')), 1 / 2_400);
});

function fakeClient(options: { prices?: number[]; failCandles?: boolean } = {}) {
  const calls = { pool: 0, ohlcv: 0 };
  const prices = [...(options.prices ?? [2_400])];
  const client = {
    pool: async () => {
      calls.pool += 1;
      const price = prices.length > 1 ? prices.shift()! : prices[0]!;
      return { ...POOL, market: { ...POOL.market, quoteInBase: price } };
    },
    ohlcv: async () => {
      calls.ohlcv += 1;
      if (options.failCandles) throw new Error('rate limited');
      return [candle(NOW - 900, 2_390, 2_410, 2_380, 2_400), candle(NOW - 86_400 - 900, 2_200, 2_210, 2_190, 2_200)];
    },
  } as unknown as GeckoTerminalClient;
  return { client, calls };
}

test('the feed reads the price every time and the 24h candles once a minute, widening high and low with the live price', async () => {
  let clock = NOW * 1000;
  const { client, calls } = fakeClient({ prices: [2_400, 2_500, 2_350] });
  const feed = new TickerFeed(client, POOL, 'auto', 60_000, () => clock);
  const first = await feed.read();
  assert.deepEqual([first.pair, first.priceUnit, first.price, first.high24h, first.low24h], ['WETH/USDC', 'USDC per WETH', 2_400, 2_410, 2_380]);
  assert.ok(Math.abs(first.change24hPct! - (2_400 / 2_200 - 1) * 100) < 1e-9);
  clock += 10_000;
  const second = await feed.read();
  assert.deepEqual([second.price, second.high24h, second.low24h], [2_500, 2_500, 2_380]); // A new high between candle reads.
  assert.deepEqual(calls, { pool: 2, ohlcv: 1 });
  clock += 60_000;
  await feed.read();
  assert.deepEqual(calls, { pool: 3, ohlcv: 2 });
  assert.deepEqual(tickerJson(second), {
    pair: 'WETH/USDC', chain: 'base', chainId: 8453,
    pool: { address: POOL.address, name: POOL.name, dex: 'uniswap', dexId: 'uniswap-v3-base', version: 'v3', feeTier: 500 },
    priceUnit: 'USDC per WETH', price: 2_500, change24hPct: second.change24hPct, high24h: 2_500, low24h: 2_380,
    volume24hUsd: 12_900_000, liquidityUsd: 8_300_000, trades24h: 20_000, updatedAt: new Date(NOW * 1000 + 10_000).toISOString(), source: 'geckoterminal',
  });
});

test('a failed candle read still gives the price; a missing price is an error', async () => {
  const feed = new TickerFeed(fakeClient({ failCandles: true }).client, POOL, 'auto', 60_000, () => NOW * 1000);
  const ticker = await feed.read();
  assert.deepEqual([ticker.price, ticker.change24hPct, ticker.high24h], [2_400, undefined, undefined]);
  const empty = { pool: async () => ({ ...POOL, market: {} }), ohlcv: async () => [] } as unknown as GeckoTerminalClient;
  await assert.rejects(new TickerFeed(empty, POOL, 'auto').read(), /no current price for USDC \/ WETH 0.05% on Base/);
});

test('intervals take seconds or minutes, at least 5 seconds', () => {
  assert.equal(parseInterval('10'), 10_000);
  assert.equal(parseInterval('10s'), 10_000);
  assert.equal(parseInterval('1.5m'), 90_000);
  assert.throws(() => parseInterval('2s'), /at least 5s/);
  assert.throws(() => parseInterval('soon'), /not a duration/);
});

const sample: Ticker = {
  pair: 'WETH/USDC', pool: POOL, priceUnit: 'USDC per WETH', pricedToken: POOL.quote, quoteToken: POOL.base, price: 2_322.12, change24hPct: -1.42,
  high24h: 2_390.19, low24h: 2_291.41, volume24hUsd: 12_900_000, liquidityUsd: 8_300_000, trades24h: 20_304, updatedAt: '2026-10-29T19:24:14.000Z',
};

test('the ticker line and the watch screen show the figures, with color only when asked', () => {
  assert.equal(formatTickerLine(sample), 'WETH/USDC  2,322.12 USDC per WETH  24h -1.42%  H 2,390.19  L 2,291.41  Vol $12.9M  Liq $8.3M  Uniswap v3 0.05% on Base');
  assert.match(formatTickerLine(sample, true), /\x1b\[31m-1\.42%\x1b\[0m/);
  const screen = renderTickerScreen({ ...sample, price: 2_330 }, sample, { intervalMs: 10_000, color: false, error: 'GeckoTerminal returned HTTP 429.' });
  assert.match(screen, /▲ 2,330\.00 USDC per WETH {2}\+7\.8800/);
  assert.match(screen, /24h trades {2}20,304/);
  assert.match(screen, /every 10s · GeckoTerminal · q or Ctrl\+C to quit/);
  assert.match(screen, /Last update failed: GeckoTerminal returned HTTP 429\. Showing the previous figures/);
  assert.doesNotMatch(screen, /\x1b\[/);
  assert.match(renderTickerScreen({ ...sample, price: 2_300 }, sample, { intervalMs: 5_000, color: false }), /▼ 2,300\.00/);
});

function io(options: { tty: boolean; input?: NodeJS.ReadStream }) {
  const out: string[] = [];
  const err: string[] = [];
  const value: WatchIo = { write: (text) => out.push(text), error: (text) => err.push(text), tty: options.tty, input: options.input, render: renderTickerScreen, line: formatTickerLine };
  return { out, err, io: value };
}

test('watching without a terminal prints a line (or JSON) per update and keeps going after a failure', async () => {
  let reads = 0;
  const feed = { read: async () => { reads += 1; if (reads === 2) throw new Error('HTTP 503'); return { ...sample, price: 2_000 + reads }; } };
  const plain = io({ tty: false });
  assert.equal(await watchTicker(feed, { intervalMs: 1, count: 3, json: false, color: false }, plain.io), 2);
  assert.deepEqual(plain.out.map((line) => line.split('  ')[1]), ['2,001.00 USDC per WETH', '2,003.00 USDC per WETH']);
  assert.match(plain.err[0]!, /update failed: HTTP 503/);
  const json = io({ tty: false });
  await watchTicker({ read: async () => sample }, { intervalMs: 1, count: 2, json: true, color: false }, json.io);
  assert.deepEqual(json.out.map((line) => JSON.parse(line).price), [2_322.12, 2_322.12]);
});

test('watching in a terminal takes over the screen, quits on q, and restores the terminal', async () => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, raw: false, setRawMode(mode: boolean) { this.raw = mode; return this; }, resume() { return this; }, pause() { return this; },
  });
  const term = io({ tty: true, input: input as unknown as NodeJS.ReadStream });
  let reads = 0;
  const feed = { read: async () => { reads += 1; if (reads === 2) setImmediate(() => input.emit('data', Buffer.from('q'))); return sample; } };
  const updates = await watchTicker(feed, { intervalMs: 50, json: false, color: false }, term.io);
  assert.equal(updates, 2);
  assert.equal(term.out[0], '\x1b[?1049h\x1b[?25l');
  assert.ok(term.out.slice(1, 3).every((frame) => frame.startsWith('\x1b[H\x1b[2J') && frame.includes('2,322.12 USDC per WETH')));
  assert.equal(term.out.at(-2), '\x1b[?25h\x1b[?1049l');
  assert.equal(term.out.at(-1), `${formatTickerLine(sample)}\n`); // The last figures stay visible after quitting.
  assert.equal(input.raw, false);
  assert.equal(input.listenerCount('data'), 0);
});

test('dex-ticker prints one line, or JSON, for the deepest matching pool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-ticker-'));
  const pool = (address: string, name: string, reserve: string, price: string) => ({
    id: `base_${address}`, type: 'pool',
    attributes: { address, name, reserve_in_usd: reserve, base_token_price_quote_token: price, quote_token_price_base_token: String(1 / Number(price)), base_token_price_usd: price, quote_token_price_usd: '1', volume_usd: { h24: '5000000' }, transactions: { h24: { buys: 10, sells: 5 } } },
    relationships: { base_token: { data: { id: `base_${WETH}` } }, quote_token: { data: { id: `base_${USDC}` } }, dex: { data: { id: 'uniswap-v3-base' } } },
  });
  const tokens = [{ id: `base_${WETH}`, type: 'token', attributes: { address: WETH, symbol: 'WETH' } }, { id: `base_${USDC}`, type: 'token', attributes: { address: USDC, symbol: 'USDC' } }];
  const deep = pool('0x6c561b446416e1a00e8e93e221854d6ea4171372', 'WETH / USDC 0.3%', '150000000', '2400');
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/search/pools') response.end(JSON.stringify({ data: [pool('0xb4cb800910b228ed3d0834cf79d697127bbb00e5', 'WETH / USDC 0.01%', '500000', '2399'), deep], included: tokens }));
    else if (url.pathname.endsWith('/ohlcv/minute')) response.end(JSON.stringify({ data: { attributes: { ohlcv_list: [candle(Math.floor(Date.now() / 1000) - 90_000, 2_000, 2_000, 2_000, 2_000), candle(Math.floor(Date.now() / 1000) - 600, 2_350, 2_450, 2_300, 2_400)] } } }));
    else response.end(JSON.stringify({ data: deep, included: tokens }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dex-ticker', ...args], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEFI_TOOL_') && key !== 'NO_COLOR')), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_GECKOTERMINAL_URL: `http://127.0.0.1:${port}` },
  });
  try {
    const line = await run(['ETH/USDC', '--chain', 'base']);
    assert.equal(line.stdout.trim(), 'WETH/USDC  2,400.00 USDC per WETH  24h +20.00%  H 2,450.00  L 2,300.00  Vol $5.0M  Liq $150.0M  Uniswap v3 0.3% on Base');
    const json = JSON.parse((await run(['ETH/USDC', '--chain', 'base', '--json'])).stdout);
    assert.deepEqual([json.pool.address, json.price, json.trades24h], [deep.attributes.address, 2_400, 15]);
    await assert.rejects(run(['ETH/USDC', '--chain', 'base', '--count', '3']), /--interval and --count only apply with --watch/);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

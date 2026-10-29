import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { autoSample, buildCandles, coverage, downloadSamples, marketFileName, marketRange, parseMarketPair, resolveCoin, sampleCandidates, sampleRequests, USD, writeMarketData, type Coin, type MarketDataset } from '../src/market-data.js';
import type { ChartSeries } from '../src/providers/prices.js';

const H = 3_600;
const ETH: Coin = { key: 'coingecko:ethereum', symbol: 'ETH' };
const BTC: Coin = { key: 'coingecko:bitcoin', symbol: 'BTC' };
const series = (entries: Array<[Coin, ChartSeries[]]>) => new Map(entries.map(([coin, pages]) => [coin.key, pages]));
const page = (points: Array<[number, unknown]>, confidence = 0.99): ChartSeries => ({ confidence, prices: points.map(([timestamp, price]) => ({ timestamp, price })) });

test('auto sampling aims for about 12 samples per candle and falls back to coarser spacing', () => {
  assert.deepEqual((['5m', '15m', '1h', '4h', '12h', '1d', '1w'] as const).map(autoSample), ['5m', '5m', '5m', '15m', '1h', '1h', '4h']);
  assert.deepEqual(sampleCandidates('1h'), ['5m', '15m', '1h']);
  assert.deepEqual(sampleCandidates('1d'), ['1h', '4h', '1d']);
  assert.deepEqual(sampleCandidates('5m'), ['5m']);
});

test('ranges align to the timeframe; weeks start on Monday 00:00 UTC', () => {
  const now = Date.UTC(2026, 9, 29, 11, 56) / 1000; // A Thursday.
  const week = marketRange('1w', now - 30 * 86_400, now, now, false);
  assert.equal(new Date(week.start * 1000).getUTCDay(), 1);
  assert.equal(new Date(week.end * 1000).toISOString(), '2026-10-26T00:00:00.000Z'); // This week has not ended.
  assert.equal(marketRange('1h', now - 3 * H, now, now, false).end, Date.UTC(2026, 9, 29, 11) / 1000);
});

test('pairs: one coin means USD; two are a cross rate', () => {
  assert.deepEqual(parseMarketPair('ETH'), ['ETH', 'USD']);
  assert.deepEqual(parseMarketPair(' BTC / eth '), ['BTC', 'eth']);
  assert.deepEqual(parseMarketPair('base:0xabc/USDC'), ['base:0xabc', 'USDC']);
  assert.throws(() => parseMarketPair('A/B/C'), /one token/);
  assert.throws(() => parseMarketPair('USD/ETH'), /put the coin first/);
});

test('coins resolve by symbol (best market-cap rank), CoinGecko ID, or chain:address', async () => {
  const searches: string[] = [];
  const search = async (query: string) => {
    searches.push(query);
    return [
      { id: 'ethereum', symbol: 'eth', name: 'Ethereum', rank: 2 },
      { id: 'ether-fake', symbol: 'ETH', name: 'Fake', rank: 900 },
      { id: 'ethena', symbol: 'ena', rank: 38 },
      { id: 'unranked-eth', symbol: 'eth' },
    ];
  };
  const symbols = async (keys: string[]) => new Map(keys.filter((key) => !key.includes('nope')).map((key) => [key.toLowerCase(), 'AERO']));
  assert.deepEqual(await resolveCoin('Eth', search, symbols), { key: 'coingecko:ethereum', symbol: 'ETH', name: 'Ethereum' });
  assert.equal(await resolveCoin('usd', search, symbols), USD);
  assert.deepEqual(await resolveCoin('CoinGecko:Aerodrome-Finance', search, symbols), { key: 'coingecko:aerodrome-finance', symbol: 'AERO' });
  assert.deepEqual(await resolveCoin('base:0x940181A94a35a4569e4529a3cdfb74e38fd98631', search, symbols), { key: 'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631', symbol: 'AERO' });
  assert.deepEqual(searches, ['Eth']);
  await assert.rejects(resolveCoin('coingecko:nope', search, symbols), /DefiLlama has no price for coingecko:nope/);
  await assert.rejects(resolveCoin('ZZZ', search, symbols), /No coin with the symbol "ZZZ"/);
});

test('samples download in pages of 500 points across the coins in each request', async () => {
  const urls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const keys = url.pathname.replace('/chart/', '').split(',');
    const start = Number(url.searchParams.get('start'));
    const span = Number(url.searchParams.get('span'));
    return Response.json({ coins: Object.fromEntries(keys.map((key) => [key, { symbol: 'X', confidence: 0.99, prices: Array.from({ length: span }, (_, i) => ({ timestamp: start + i * 300 + 20, price: 1 })) }])) });
  }) as typeof fetch;
  const start = 1_000 * H;
  const end = start + 3 * 86_400; // 864 five-minute samples per coin.
  const pair = await downloadSamples([BTC, ETH], start, end, '5m', { endpoint: 'http://llama.test', fetcher });
  assert.equal(pair.requests, 4); // 250 per coin per request.
  assert.equal(sampleRequests([BTC, ETH], start, end, '5m'), 4);
  assert.deepEqual(urls.map((url) => [url.pathname, url.searchParams.get('span'), url.searchParams.get('period')]), [
    ['/chart/coingecko:bitcoin,coingecko:ethereum', '250', '5m'], ['/chart/coingecko:bitcoin,coingecko:ethereum', '250', '5m'],
    ['/chart/coingecko:bitcoin,coingecko:ethereum', '250', '5m'], ['/chart/coingecko:bitcoin,coingecko:ethereum', '114', '5m'],
  ]);
  assert.equal(Number(urls[1]!.searchParams.get('start')), start + 250 * 300);
  assert.equal(pair.series.get(ETH.key)!.flatMap((item) => item.prices).length, 864);
  const single = await downloadSamples([ETH, USD], start, end, '5m', { endpoint: 'http://llama.test', fetcher });
  assert.equal(single.requests, 2); // 500 per request for one coin; USD needs no prices.
});

test('candles take open, high, low and close from the samples, fill quiet periods, and report problems', () => {
  const start = 100 * H;
  const end = 106 * H;
  const data = series([[ETH, [page([
    [99 * H + 30, 50], // Before the range.
    [101 * H + 30, 10], [101 * H + 1_200, 14], [101 * H + 2_400, 8], [101 * H + 3_300, 12],
    [101 * H + 3_300, 99], // Duplicate time: the first is kept.
    [102 * H + 30, 0], // Zero price.
    [102 * H + 60, 'x'], // Malformed.
    [104 * H + 30, 30], // A >50% jump after the filled hours.
    [106 * H + 30, 31], // After the range.
  ], 0.97)]]]);
  const { candles, validation } = buildCandles(ETH, USD, data, '1h', '15m', start, end, 'forward');
  assert.deepEqual(candles.map((candle) => [candle.timestamp / H, candle.open, candle.high, candle.low, candle.close, candle.samples, candle.filled]), [
    [101, 10, 14, 8, 12, 4, false], [102, 12, 12, 12, 12, 0, true], [103, 12, 12, 12, 12, 0, true], [104, 30, 30, 30, 30, 1, false], [105, 30, 30, 30, 30, 0, true],
  ]);
  assert.deepEqual(validation, {
    received: { ETH: 10 }, trimmed: 2, dropped: { 'non-positive price': 1, malformed: 1 }, duplicates: 1, unmatched: 0, missing: 3, filled: 3,
    lowSamples: 1, jumps: 1, leadingEmpty: 1, confidence: { ETH: 0.97 }, complete: true,
  });
  assert.equal(coverage(candles), 2 / 5);
  const none = buildCandles(ETH, USD, data, '1h', '15m', start, end, 'none');
  assert.deepEqual(none.candles.map((candle) => candle.timestamp / H), [101, 104]);
  assert.equal(none.validation.complete, false);
  const empty = buildCandles(ETH, USD, series([]), '1h', '15m', start, end, 'forward');
  assert.deepEqual([empty.candles.length, empty.validation.leadingEmpty, empty.validation.complete, empty.validation.received], [0, 6, false, { ETH: 0 }]);
});

test('cross rates divide by the quote sample nearest in time, within half a sample period', () => {
  const start = 100 * H;
  const data = series([
    [BTC, [page([[start + 100, 80_000], [start + 400, 81_000], [start + 700, 82_000]])]],
    // ETH's samples are a few seconds off BTC's; the third is too far away (190s > 150s).
    [ETH, [page([[start + 130, 2_000], [start + 395, 2_025], [start + 890, 2_050]], 0.9)]],
  ]);
  const { candles, validation } = buildCandles(BTC, ETH, data, '15m', '5m', start, start + 900, 'forward');
  assert.deepEqual(candles.map((candle) => [candle.open, candle.close, candle.samples]), [[40, 40, 2]]);
  assert.deepEqual([validation.unmatched, validation.received, validation.confidence], [1, { BTC: 3, ETH: 3 }, { BTC: 0.99, ETH: 0.9 }]);
});

test('market files hold open, high, low, close, samples and filled, with metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-market-'));
  try {
    const start = 100 * H;
    const { candles, validation } = buildCandles(ETH, USD, series([[ETH, [page([[start + 30, 2], [start + 60, 3], [start + 2 * H, 4]])]]]), '1h', '5m', start, start + 3 * H, 'forward');
    const dataset: MarketDataset = {
      source: 'defillama', pair: 'ETH', base: ETH, quote: USD, priceUnit: 'USD per ETH', method: 'ETH\'s blended USD price', timeframe: '1h', sample: '5m',
      from: '1970-01-05T04:00:00Z', to: '1970-01-05T07:00:00Z', fill: 'forward', downloadedAt: '2026-10-29T12:00:00.000Z', requests: 1, candles: candles.length, validation,
    };
    const name = marketFileName(ETH, USD, '1h', start, start + 3 * H, 'csv');
    assert.equal(name, 'ETH-USD_1h_19700105-0400_19700105-0700.csv');
    await writeMarketData(directory, name, candles, dataset, 'csv', false);
    assert.equal(readFileSync(join(directory, name), 'utf8'), [
      'time,timestamp,open,high,low,close,samples,filled',
      '1970-01-05T04:00:00Z,360000,2,3,2,3,2,false',
      '1970-01-05T05:00:00Z,363600,3,3,3,3,0,true',
      '1970-01-05T06:00:00Z,367200,4,4,4,4,1,false', '',
    ].join('\n'));
    assert.equal(JSON.parse(readFileSync(join(directory, `${name}.meta.json`), 'utf8')).method, 'ETH\'s blended USD price');
    await assert.rejects(writeMarketData(directory, name, candles, dataset, 'csv', false), /already exists/);
    await writeMarketData(directory, 'm.parquet', candles, dataset, 'parquet', false);
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(join(directory, 'm.parquet')) });
    assert.deepEqual(rows.map((row) => [row.close, row.samples, row.filled]), [[3, 2, false], [3, 0, true], [4, 1, false]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('market-data download looks up coins, retries sparse coins at a coarser spacing, and writes a file per pair', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-market-cli-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push(`${url.pathname}${url.searchParams.get('period') ? `@${url.searchParams.get('period')}` : ''}`);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/search') { response.end(JSON.stringify({ coins: [{ id: 'aerodrome-finance', symbol: 'aero', name: 'Aerodrome', market_cap_rank: 120 }] })); return; }
    const keys = url.pathname.replace('/chart/', '').split(',');
    const start = Number(url.searchParams.get('start'));
    const period = url.searchParams.get('period')!;
    const step = { '5m': 300, '15m': 900, '1h': 3_600 }[period]!;
    // Like DefiLlama for a smaller coin: nothing at 5-minute spacing, a full series at 15 minutes.
    const prices = period === '5m' ? [] : Array.from({ length: Number(url.searchParams.get('span')) }, (_, i) => ({ timestamp: start + i * step + 10, price: 1.5 }));
    response.end(JSON.stringify({ coins: Object.fromEntries(keys.map((key) => [key, { symbol: 'AERO', confidence: 0.99, prices }])) }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'market-data', 'download', 'AERO', '--from', '2d', '--out-dir', directory, '--json'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEFI_TOOL_'))), DEFI_TOOL_CONFIG: join(directory, 'missing.json'),
        DEFI_TOOL_PRICES_URL: `http://127.0.0.1:${port}`, DEFI_TOOL_COINGECKO_URL: `http://127.0.0.1:${port}` },
    });
    const [summary] = JSON.parse(result.stdout).data;
    assert.deepEqual([summary.base.key, summary.quote.key, summary.priceUnit, summary.sample], ['coingecko:aerodrome-finance', 'usd', 'USD per AERO', '15m']);
    assert.equal(requests[0], '/search');
    assert.ok(requests.includes('/chart/coingecko:aerodrome-finance@5m') && requests.includes('/chart/coingecko:aerodrome-finance@15m'));
    assert.ok(!requests.some((item) => item.endsWith('@1h')), 'stops once coverage is good');
    assert.deepEqual([summary.validation.filled, summary.validation.complete], [0, true]);
    const lines = readFileSync(summary.files[0], 'utf8').trim().split('\n');
    assert.equal(lines.length, summary.candles + 1);
    assert.match(lines[1]!, /,1.5,1.5,1.5,1.5,4,false$/);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

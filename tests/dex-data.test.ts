import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { classifyDex, GeckoTerminalClient, type GeckoPool } from '../src/providers/geckoterminal.js';
import { candleRange, cleanCandles, datasetFileName, downloadCandles, findPools, parseTime, priceUnit, writeDataset, type DexDataset } from '../src/dex-data.js';

const H = 3_600;
const NOW = 1_793_275_000; // 2026-10-29 11:56:40 UTC
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL: GeckoPool = {
  chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', name: 'USDC / WETH 0.05%', dexId: 'uniswap-v3-base', dex: 'uniswap', version: 'v3', feeTier: 500,
  base: { address: USDC, symbol: 'USDC' }, quote: { address: WETH, symbol: 'WETH' }, tvlUsd: 8e6,
};
const candle = (time: number, close: number, open = close) => [time, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 10];

test('times: durations ago, UTC dates and date-times, unix seconds, now', () => {
  const now = NOW * 1000;
  assert.equal(parseTime('now', '--to', now), NOW);
  assert.equal(parseTime('30d', '--from', now), NOW - 30 * 86_400);
  assert.equal(parseTime('12H', '--from', now), NOW - 12 * H);
  assert.equal(parseTime('2w', '--from', now), NOW - 14 * 86_400);
  assert.equal(parseTime('2026-10-01', '--from', now), Date.UTC(2026, 9, 1) / 1000);
  assert.equal(parseTime('2026-10-01T12:30', '--from', now), Date.UTC(2026, 9, 1, 12, 30) / 1000);
  assert.equal(parseTime('2026-10-01T12:30+02:00', '--from', now), Date.UTC(2026, 9, 1, 10, 30) / 1000);
  assert.equal(parseTime('1791547200', '--from', now), 1_791_547_200);
  assert.throws(() => parseTime('yesterday', '--from', now), /--from "yesterday" is not a time/);
  assert.throws(() => parseTime('2026-13-45', '--from', now), /not a time/);
});

test('ranges align to the timeframe, skip the unfinished candle, and stay within 180 days', () => {
  // 11:56 now: the 11:00 hour is unfinished, so the last kept candle is 10:00 and the range ends at 11:00.
  assert.deepEqual(candleRange('1h', NOW - 3 * H, NOW, NOW, false), { start: Math.ceil((NOW - 3 * H) / H) * H, end: Math.floor(NOW / H) * H });
  assert.equal(candleRange('1h', NOW - 3 * H, NOW, NOW, true).end, Math.ceil(NOW / H) * H);
  assert.equal(candleRange('1d', NOW - 10 * 86_400, NOW, NOW, false).end % 86_400, 0);
  assert.throws(() => candleRange('1h', NOW - 200 * 86_400, NOW, NOW, false), /last 180 days; --from is 200 days ago/);
  assert.throws(() => candleRange('1h', NOW, NOW - H, NOW, false), /earlier than --to/);
  assert.throws(() => candleRange('1d', NOW - H, NOW, NOW, false), /No complete 1d candle/);
});

test('cleaning drops bad rows, merges duplicates, trims the range, and fills quiet periods forward', () => {
  const start = 100 * H;
  const end = 110 * H;
  const raw = [
    candle(109 * H - 0, 13), // Newest first, as pages arrive.
    candle(104 * H, 12, 11),
    candle(104 * H, 12.5, 11), // Same period again, different values: the first copy wins.
    candle(102 * H, 11),
    candle(101 * H, 10), // First trade; 100:00 has none and stays empty.
    candle(99 * H, 9), // Before the range.
    [105 * H, 1, 0.5, 2, 1, 1], // High below low.
    [106 * H + 5, 1, 2, 0.5, 1, 1], // Misaligned.
    [107 * H, 0, 1, 0, 1, 1], // Zero price.
    [108 * H, 1, 2, 0.5, 1, -3], // Negative volume.
    ['x', 1, 2, 3], // Malformed.
  ];
  const { candles, validation } = cleanCandles(raw, '1h', start, end, 'forward');
  assert.deepEqual(candles.map((item) => [item.timestamp / H, item.close, item.filled]), [
    [101, 10, false], [102, 11, false], [103, 11, true], [104, 12, false], [105, 12, true], [106, 12, true], [107, 12, true], [108, 12, true], [109, 13, false],
  ]);
  const filled = candles.find((item) => item.filled)!;
  assert.deepEqual([filled.open, filled.high, filled.low, filled.close, filled.volume], [11, 11, 11, 11, 0]);
  assert.deepEqual(validation, {
    received: raw.length, trimmed: 1, dropped: { 'high/low inconsistent': 1, 'misaligned time': 1, 'non-positive price': 1, 'negative volume': 1, malformed: 1 },
    duplicates: 1, conflicts: 1, missing: 5, filled: 5, jumps: 0, leadingEmpty: 1, complete: true,
  });

  // --fill none keeps only real candles; quiet periods after the last trade count as missing too.
  const none = cleanCandles([candle(103 * H, 4), candle(101 * H, 2)], '1h', start, end, 'none');
  assert.deepEqual(none.candles.map((item) => item.timestamp / H), [101, 103]);
  assert.equal(none.validation.missing, 1 + 6);
  assert.equal(none.validation.complete, false);
  assert.equal(none.validation.jumps, 1); // 2 → 4 is a 100% move.

  const empty = cleanCandles([], '1h', start, end, 'forward');
  assert.deepEqual([empty.candles.length, empty.validation.leadingEmpty, empty.validation.complete], [0, 10, false]);
});

test('downloads page backwards, skipping the partial boundary candle, until the range start', async () => {
  const requests: URLSearchParams[] = [];
  // 2,500 hourly candles exist; each request returns up to 1,000 ending at before_timestamp (inclusive).
  const first = 1_000 * H;
  const all = Array.from({ length: 2_500 }, (_, i) => first + i * H);
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.searchParams);
    assert.match(url.pathname, /\/networks\/base\/pools\/0xd0b5.*\/ohlcv\/hour$/);
    const before = Number(url.searchParams.get('before_timestamp'));
    const rows = all.filter((time) => time <= before).slice(-1_000).reverse()
      // The candle at before_timestamp holds only that second's trades: a partial copy with a wrong close.
      .map((time) => time === before ? candle(time, 1) : candle(time, 2_000 + time / H));
    return Response.json({ data: { attributes: { ohlcv_list: rows } } });
  }) as typeof fetch;
  const client = new GeckoTerminalClient({ endpoint: 'http://gecko.test', fetcher, intervalMs: 0 });
  const start = first + 100 * H;
  const end = first + 2_500 * H;
  const { raw, requests: count } = await downloadCandles(client, POOL, '1h', start, end, { token: WETH, currency: 'token' });
  assert.equal(count, 3);
  assert.deepEqual(requests.map((params) => [params.get('aggregate'), params.get('limit'), params.get('token'), params.get('currency')]), Array(3).fill(['1', '1000', WETH, 'token']));
  const { candles, validation } = cleanCandles(raw, '1h', start, end, 'forward');
  assert.equal(candles.length, 2_400);
  assert.ok(candles.every((item) => item.close === 2_000 + item.timestamp / H), 'no partial boundary copy');
  assert.deepEqual([validation.duplicates, validation.missing, validation.leadingEmpty, validation.complete], [0, 0, 0, true]);
});

test('rate limits wait and retry; refused old data names the 180-day limit', async () => {
  let calls = 0;
  const limited = (async () => (calls += 1) === 1 ? new Response('slow down', { status: 429 }) : Response.json({ data: { attributes: { ohlcv_list: [] } } })) as typeof fetch;
  const client = new GeckoTerminalClient({ endpoint: 'http://gecko.test', fetcher: limited, intervalMs: 0, rateLimitWaitMs: 1 });
  assert.deepEqual(await client.ohlcv(8453, POOL.address, '1h', { token: WETH, currency: 'token' }), []);
  assert.equal(calls, 2);
  const refused = new GeckoTerminalClient({ endpoint: 'http://gecko.test', fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch, intervalMs: 0 });
  await assert.rejects(downloadCandles(refused, POOL, '1h', 0, 10 * H, { token: WETH, currency: 'token' }), /free API serves only the last 180 days/);
});

test('exchange IDs map to --dex and --protocol', () => {
  assert.deepEqual(classifyDex('uniswap-v3-base'), { dex: 'uniswap', version: 'v3' });
  assert.deepEqual(classifyDex('uniswap_v3'), { dex: 'uniswap', version: 'v3' });
  assert.deepEqual(classifyDex('uniswap-v4-arbitrum'), { dex: 'uniswap', version: 'v4' });
  assert.deepEqual(classifyDex('uniswap-bsc'), { dex: 'uniswap', version: 'v3' });
  assert.deepEqual(classifyDex('uniswap_v2'), { dex: 'uniswap', version: 'v2' });
  assert.deepEqual(classifyDex('pancakeswap-v3-base'), { dex: 'pancakeswap', version: 'v3' });
  assert.deepEqual(classifyDex('aerodrome-slipstream'), { dex: 'aerodrome', version: 'clmm' });
  assert.deepEqual(classifyDex('aerodrome-base'), { dex: 'aerodrome', version: 'amm' });
  assert.deepEqual(classifyDex('curve-base'), { dex: 'curve', version: 'amm' });
  assert.deepEqual(classifyDex('raydium-clmm'), { dex: 'raydium', version: 'clmm' });
  assert.deepEqual(classifyDex('raydium'), { dex: 'raydium', version: 'amm' });
  assert.equal(classifyDex('sushiswap-v3-base'), undefined);
});

const resource = (address: string, name: string, dex: string, base: string, quote: string, reserve: string) => ({
  id: `base_${address}`, type: 'pool', attributes: { address, name, reserve_in_usd: reserve, pool_created_at: '2024-03-23T12:55:07Z' },
  relationships: { base_token: { data: { id: `base_${base}` } }, quote_token: { data: { id: `base_${quote}` } }, dex: { data: { id: dex } } },
});
const tokens = [{ id: `base_${WETH}`, type: 'token', attributes: { address: WETH, symbol: 'WETH' } }, { id: `base_${USDC}`, type: 'token', attributes: { address: USDC, symbol: 'USDC' } }];
const searchResults = [
  resource('0x6c561b446416e1a00e8e93e221854d6ea4171372', 'WETH / USDC 0.3%', 'uniswap-v3-base', WETH, USDC, '157000000'),
  resource('0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59', 'WETH / USDC 0.05%', 'aerodrome-slipstream', WETH, USDC, '4700000'),
  resource('0xd0b53d9277642d899df5c87a3966a349a798f224', 'USDC / WETH 0.05%', 'uniswap-v3-base', USDC, WETH, '8000000'),
  resource('0x4cd11e745c0f2645b5dbd50f49f50a5b4aa0a9eaacd84d2a871d10c1784b84ce', 'WETH / USDC', 'uniswap-v4-base', WETH, USDC, '250000'),
];

test('pairs resolve to matching pools, deepest first, by symbol or address', async () => {
  const urls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return Response.json({ data: searchResults, included: tokens });
  }) as typeof fetch;
  const client = new GeckoTerminalClient({ endpoint: 'http://gecko.test', fetcher, intervalMs: 0 });
  const query = { pair: ['eth', 'usdc'] as [string, string], dexes: ['uniswap' as const], versions: ['v3' as const] };
  assert.deepEqual((await findPools(client, 8453, query)).map((pool) => pool.name), ['WETH / USDC 0.3%', 'USDC / WETH 0.05%']);
  assert.equal(urls[0]!.pathname, '/search/pools');
  assert.equal(urls[0]!.searchParams.get('query'), 'eth usdc');
  assert.equal(urls[0]!.searchParams.get('network'), 'base');
  assert.deepEqual((await findPools(client, 8453, { ...query, feeTier: 500 })).map((pool) => pool.address), [POOL.address]);
  assert.deepEqual((await findPools(client, 8453, { ...query, dexes: ['uniswap', 'aerodrome'], versions: ['v4', 'clmm'] })).map((pool) => pool.dexId), ['aerodrome-slipstream', 'uniswap-v4-base']);
  await findPools(client, 8453, { ...query, pair: [WETH, 'usdc'] });
  assert.equal(urls.at(-1)!.pathname, `/networks/base/tokens/${WETH}/pools`);
});

test('prices quote in the money-like token by default, or USD, or the token asked for', () => {
  assert.deepEqual(priceUnit(POOL, 'auto'), { priced: POOL.quote, quote: POOL.base, currency: 'token', label: 'USDC per WETH' });
  assert.deepEqual(priceUnit(POOL, 'usd'), { priced: POOL.quote, currency: 'usd', label: 'USD per WETH' });
  assert.equal(priceUnit(POOL, 'ETH').label, 'WETH per USDC');
  assert.throws(() => priceUnit(POOL, 'DAI'), /--quote "DAI" is not a token of USDC \/ WETH 0.05%/);
});

test('files: CSV, JSON lines, JSON and Parquet hold the same candles, with metadata, and are not overwritten by accident', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dex-'));
  try {
    const { candles, validation } = cleanCandles([candle(102 * H, 11), candle(100 * H, 10)], '1h', 100 * H, 103 * H, 'forward');
    const base = {
      source: 'geckoterminal' as const, pool: { chain: 'base', chainId: POOL.chainId, dex: POOL.dex, dexId: POOL.dexId, version: POOL.version, address: POOL.address, name: POOL.name, feeTier: 500 },
      pair: 'WETH/USDC', priceUnit: 'USDC per WETH', pricedToken: POOL.quote, quoteToken: POOL.base, volumeUnit: 'USDC', timeframe: '1h' as const,
      from: '1970-01-05T04:00:00Z', to: '1970-01-05T07:00:00Z', fill: 'forward' as const,
    };
    const dataset: DexDataset = { ...base, downloadedAt: '2026-10-29T12:00:00.000Z', requests: 1, candles: candles.length, validation };
    const name = datasetFileName(base, 100 * H, 103 * H, 'csv');
    assert.equal(name, 'WETH-USDC_base_uniswap-v3-0.05_0xd0b53d_1h_19700105-0400_19700105-0700.csv');

    assert.deepEqual(await writeDataset(directory, name, candles, dataset, 'csv', false), [join(directory, name), join(directory, `${name}.meta.json`)]);
    assert.equal(readFileSync(join(directory, name), 'utf8'), [
      'time,timestamp,open,high,low,close,volume,filled',
      '1970-01-05T04:00:00Z,360000,10,11,9,10,10,false',
      '1970-01-05T05:00:00Z,363600,10,10,10,10,0,true',
      '1970-01-05T06:00:00Z,367200,11,12,10,11,10,false', '',
    ].join('\n'));
    assert.equal(JSON.parse(readFileSync(join(directory, `${name}.meta.json`), 'utf8')).validation.filled, 1);
    await assert.rejects(writeDataset(directory, name, candles, dataset, 'csv', false), /already exists. Add --force/);
    await writeDataset(directory, name, candles, dataset, 'csv', true);

    await writeDataset(directory, 'c.jsonl', candles, dataset, 'jsonl', false);
    assert.deepEqual(readFileSync(join(directory, 'c.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).close), [10, 10, 11]);
    assert.deepEqual(await writeDataset(directory, 'c.json', candles, dataset, 'json', false), [join(directory, 'c.json')]);
    const json = JSON.parse(readFileSync(join(directory, 'c.json'), 'utf8'));
    assert.deepEqual([json.meta.priceUnit, json.candles.length, json.candles[1].filled], ['USDC per WETH', 3, true]);

    await writeDataset(directory, 'c.parquet', candles, dataset, 'parquet', false);
    const file = await asyncBufferFromFile(join(directory, 'c.parquet'));
    const rows = await parquetReadObjects({ file });
    assert.deepEqual(rows.map((item) => [Number(item.timestamp), item.close, item.filled]), [[360000, 10, false], [363600, 10, true], [367200, 11, false]]);
    assert.equal((rows[0]!.time as Date).toISOString(), '1970-01-05T04:00:00.000Z');
    const meta = (await parquetMetadataAsync(file)).key_value_metadata?.find((item) => item.key === 'defi-tool');
    assert.equal(JSON.parse(meta!.value!).pool.address, POOL.address);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dex-data download finds the pool, downloads, and writes a file per pair', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dex-cli-'));
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / H) * H;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/search/pools') { response.end(JSON.stringify({ data: searchResults, included: tokens })); return; }
    // Hourly candles for the last 3 days, plus the unfinished current hour; one quiet hour.
    const rows = Array.from({ length: 73 }, (_, i) => hour - i * H).filter((time) => time !== hour - 5 * H).map((time) => candle(time, 2_500));
    response.end(JSON.stringify({ data: { attributes: { ohlcv_list: rows } } }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dex-data', 'download', 'ETH/USDC', '--chain', 'base', '--fee', '0.05', '--from', '2d', '--out-dir', directory, '--json'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEFI_TOOL_'))), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_GECKOTERMINAL_URL: `http://127.0.0.1:${port}` },
    });
    const [summary] = JSON.parse(result.stdout).data;
    assert.equal(summary.pool.address, POOL.address);
    assert.equal(summary.priceUnit, 'USDC per WETH');
    // Whole hours from 2 days ago up to the current, unfinished hour.
    const periods = (hour - Math.ceil((now - 2 * 86_400) / H) * H) / H;
    assert.equal(summary.candles, periods);
    assert.deepEqual([summary.validation.filled, summary.validation.complete], [1, true]);
    assert.deepEqual(readdirSync(directory).sort(), [summary.files[0].split('/').at(-1), summary.files[1].split('/').at(-1)].sort());
    const lines = readFileSync(summary.files[0], 'utf8').trim().split('\n');
    assert.equal(lines.length, periods + 1);
    assert.ok(Number(lines.at(-1)!.split(',')[1]) < hour, 'the unfinished hour is left out');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

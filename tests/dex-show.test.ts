import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedPools, listCachedFiles, loadShowData, readCachedCandles, resampleCandles, uncovered, type SeriesKey } from '../src/dex-cache.js';
import { datasetHeader, priceUnit, writeDataset, type Candle, type DexDataset } from '../src/dex-data.js';
import { compressCandles, renderCandleChart, visible } from '../src/terminal-chart.js';
import { renderShow, showStats, type ShowView } from '../src/dex-show.js';
import { buildChartHtml } from '../src/html-chart.js';
import type { GeckoPool, GeckoTerminalClient } from '../src/providers/geckoterminal.js';
import type { CandleFormat } from '../src/candle-files.js';

const H = 3_600;
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL: GeckoPool = {
  chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', name: 'USDC / WETH 0.05%', dexId: 'uniswap-v3-base', dex: 'uniswap', version: 'v3', feeTier: 500,
  base: { address: USDC, symbol: 'USDC' }, quote: { address: WETH, symbol: 'WETH' }, tvlUsd: 8e6,
};
const UNIT = priceUnit(POOL, 'auto');
const KEY: SeriesKey = { chainId: 8453, address: POOL.address, priced: WETH, quote: USDC };
const candle = (timestamp: number, close: number, open = close, volume = 10, filled = false): Candle => ({ timestamp, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume, filled });

/** Save candles the way dex-data download does, with metadata covering [from, to). */
async function save(directory: string, candles: Candle[], timeframe: '15m' | '1h', from: number, to: number, format: CandleFormat, downloadedAt: string) {
  const header = datasetHeader(POOL, UNIT, 'WETH/USDC', timeframe, from, to, 'forward');
  const dataset: DexDataset = { ...header, downloadedAt, requests: 1, candles: candles.length, validation: { received: 0, trimmed: 0, dropped: {}, duplicates: 0, conflicts: 0, missing: 0, filled: 0, jumps: 0, leadingEmpty: 0, complete: true } };
  await writeDataset(directory, `${timeframe}-${from}-${format}.${format}`, candles, dataset, format, false);
}

test('ranges: what is left of [start, end) after the covered spans', () => {
  assert.deepEqual(uncovered(0, 100, []), [[0, 100]]);
  assert.deepEqual(uncovered(0, 100, [[20, 40], [30, 60], [80, 120]]), [[0, 20], [60, 80]]);
  assert.deepEqual(uncovered(0, 100, [[-10, 200]]), []);
});

test('finer candles group into larger ones: first open, extreme high and low, last close, summed volume', () => {
  const quarter = [candle(100 * H, 10, 9), candle(100 * H + 900, 12, 10), candle(100 * H + 2_700, 11, 12, 5, true), candle(101 * H, 13, 11, 10, true)];
  assert.deepEqual(resampleCandles(quarter, H), [
    { timestamp: 100 * H, open: 9, high: 13, low: 8, close: 11, volume: 25, filled: false },
    { timestamp: 101 * H, open: 11, high: 14, low: 10, close: 13, volume: 10, filled: true },
  ]);
});

test('the cache reads every format, merges files, groups finer ones, and downloads only the missing range', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-cache-'));
  try {
    // 1h candles for hours 100-103 (CSV), a newer 15m file for hours 103-105 (Parquet), and an unrelated pool (JSON).
    await save(directory, [100, 101, 102, 103].map((hour) => candle(hour * H, hour)), '1h', 100 * H, 104 * H, 'csv', '2026-10-01T00:00:00Z');
    const quarters = Array.from({ length: 8 }, (_, i) => candle(103 * H + i * 900, 200 + i));
    await save(directory, quarters, '15m', 103 * H, 105 * H, 'parquet', '2026-10-02T00:00:00Z');
    const other = datasetHeader({ ...POOL, address: '0x0000000000000000000000000000000000000001' }, UNIT, 'X/Y', '1h', 0, H, 'forward');
    await writeDataset(directory, 'other.json', [candle(0, 1)], { ...other, downloadedAt: '2026-10-03T00:00:00Z', requests: 1, candles: 1, validation: {} as DexDataset['validation'] }, 'json', false);
    const files = await listCachedFiles(directory);
    assert.equal(files.length, 3);
    assert.deepEqual((await readCachedCandles(files.find((file) => file.format === 'parquet')!)).map((item) => item.close), quarters.map((item) => item.close));
    assert.equal((await cachedPools(directory))[0]!.meta.pair, 'X/Y'); // Newest download first.

    const requests: number[] = [];
    const client = {
      ohlcv: async (_chain: number, _pool: string, _tf: string, options: { before: number }) => {
        requests.push(options.before);
        // Hours 105-107 exist on GeckoTerminal.
        return [107, 106, 105].filter((hour) => hour * H <= options.before).map((hour) => [hour * H, hour, hour + 1, hour - 1, hour, 1]);
      },
    } as unknown as GeckoTerminalClient;
    const now = 108 * H + 60;
    const data = await loadShowData({ directory, key: KEY, timeframe: '1h', start: 100 * H, end: 108 * H, now, offline: false, refresh: false, client, pool: POOL, unit: UNIT, pair: 'WETH/USDC' });
    assert.deepEqual(data.candles.map((item) => [item.timestamp / H, item.close]), [[100, 100], [101, 101], [102, 102], [103, 203], [104, 207], [105, 105], [106, 106], [107, 107]]);
    // Hour 103 comes from the newer 15m file (open of its first quarter, close of its last).
    assert.equal(data.candles[3]!.open, 200);
    assert.equal(data.cached.length, 2);
    assert.equal(data.downloaded.length, 1);
    assert.deepEqual(requests, [108 * H - 1]); // Only hours 105-107 were asked for, in one request reaching back to hour 105.
    assert.deepEqual(data.unavailable, []);
    assert.ok(readdirSync(directory).some((name) => name.endsWith('.csv') && name.includes('20') && name !== '1h-360000-csv.csv'), 'the download is saved to the cache');

    // The next run needs no download; offline, a gap stays a gap.
    requests.length = 0;
    const again = await loadShowData({ directory, key: KEY, timeframe: '1h', start: 100 * H, end: 108 * H, now, offline: true, refresh: false, pair: 'WETH/USDC' });
    assert.equal(again.candles.length, 8);
    assert.deepEqual(requests, []);
    const wider = await loadShowData({ directory, key: KEY, timeframe: '1h', start: 98 * H, end: 108 * H, now, offline: true, refresh: false, pair: 'WETH/USDC' });
    assert.deepEqual(wider.unavailable, [[98 * H, 100 * H]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the terminal chart draws bodies, wicks, the live price, volume and time labels within the width', () => {
  const candles = [candle(100 * H, 12, 10, 5), candle(101 * H, 9, 12, 20), candle(102 * H, 9, 9, 0, true), candle(103 * H, 14, 9, 10)];
  const { lines, merged } = renderCandleChart(candles, { width: 60, height: 10, volumeHeight: 3, color: false, live: 11 });
  assert.equal(merged, 1);
  assert.ok(lines.every((line) => visible(line).length <= 60 + 12), 'fits the width');
  assert.ok(lines.some((line) => line.includes('┃')), 'bodies');
  assert.ok(lines.some((line) => /[│╵╷]/.test(line.split(' ┤')[0]!)), 'wicks');
  const liveLine = lines.find((line) => line.includes('◀ 11.0000'))!;
  assert.match(liveLine, /┈/);
  assert.ok(lines.includes('─'.repeat(60 - 9 - 1) + ' ┤ volume') || lines.some((line) => line.endsWith('┤ volume')));
  assert.match(lines.at(-1)!, /^04:00 +\d\d:00/); // Hour 100 after the epoch is 04:00 UTC.
  // Many candles merge so each column holds several.
  const many = Array.from({ length: 500 }, (_, i) => candle(i * H, 100 + Math.sin(i / 10) * 5));
  const fitted = renderCandleChart(many, { width: 80, height: 8, volumeHeight: 0, color: true });
  assert.ok(fitted.merged >= 7);
  assert.ok(fitted.lines.every((line) => visible(line).length <= 80 + 12));
  assert.match(fitted.lines.join(''), /\x1b\[3[12]m/);
  assert.deepEqual(compressCandles(candles, 2).map((item) => [item.open, item.high, item.low, item.close, item.volume]), [[10, 13, 8, 9, 25], [9, 15, 8, 14, 10]]);
});

const view = (candles: Candle[]): ShowView => ({
  pair: 'WETH/USDC', poolLabel: 'Uniswap v3 0.05%', chainId: 8453, address: POOL.address, priceUnit: 'USDC per WETH', volumeUnit: 'USDC', timeframe: '1h', step: H,
  candles, stats: showStats(candles, H), tickerNote: 'offline', sources: { cached: ['a.csv'], downloaded: [], unavailable: [], requests: 0 },
});

test('figures for the range: change, high and low with their times, volume, volatility, filled candles', () => {
  const candles = [candle(100 * H, 100, 100), candle(101 * H, 110, 100), candle(102 * H, 99, 110, 0, true)];
  const stats = showStats(candles, H)!;
  assert.ok(Math.abs(stats.changePct + 1) < 1e-9);
  assert.deepEqual([stats.high, stats.highAt, stats.low, stats.lowAt, stats.volume, stats.filled], [111, 101 * H, 98, 102 * H, 20, 1]);
  assert.ok(stats.volatilityPct! > 0);
  assert.equal(showStats([], H), undefined);
  const text = renderShow(view(candles), { width: 90, height: 20, volume: true, color: false });
  assert.match(text, /^Live price unavailable: offline\./);
  assert.match(text, /Change -1\.00% {3}High 111\.0000 1970-01-05 05:00 {3}Low 98\.0000 1970-01-05 06:00 {3}Volume 20\.00 USDC/);
  assert.match(text, /Candles 3 \(1 quiet, filled\)/);
  assert.match(renderShow(view([]), { width: 90, height: 20, volume: true, color: false }), /No candles in this range/);
});

test('the HTML page is self-contained, carries the data, and cannot be broken out of by its content', () => {
  const html = buildChartHtml({ ...view([candle(100 * H, 10)]), pair: 'A</script><b>/USDC' }, new Date('2026-10-29T12:00:00Z'));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /LightweightCharts/); // The library is inlined.
  assert.doesNotMatch(html, /<script src=/);
  assert.doesNotMatch(html, /A<\/script><b>/);
  assert.match(html, /<title>A&lt;\/script&gt;&lt;b&gt;\/USDC chart<\/title>/);
  const data = JSON.parse(/const DATA = (.*);\n/.exec(html)![1]!.replace(/<\\\//g, '</'));
  assert.deepEqual(data.candles, [[100 * H, 10, 11, 9, 10, 10, 0]]);
  assert.equal(data.priceUnit, 'USDC per WETH');
});

test('dex-data show charts cached downloads offline, as text or JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-show-cli-'));
  try {
    const now = Math.floor(Date.now() / 1000 / H) * H;
    await save(directory, Array.from({ length: 24 }, (_, i) => candle(now - (24 - i) * H, 2_300 + i, 2_299 + i)), '1h', now - 24 * H, now, 'jsonl', new Date().toISOString());
    const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dex-data', 'show', ...args, '--data-dir', directory, '--offline'], {
      encoding: 'utf8', timeout: 20_000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEFI_TOOL_'))), DEFI_TOOL_CONFIG: join(directory, 'missing.json') },
    });
    const text = (await run(['ETH/USDC', '--width', '90', '--height', '24'])).stdout;
    assert.match(text, /Live price unavailable: offline/);
    assert.match(text, /WETH\/USDC {2}Uniswap v3 0\.05% · Base · 0xd0b5…f224 · USDC per WETH/);
    assert.match(text, /Candles 24/);
    assert.match(text, /Data: 1 cached file/);
    assert.match(text, /No data for .* not in the cache and older than GeckoTerminal's 180 days|Data: 1 cached file/);
    const json = JSON.parse((await run(['WETH/USDC', '--json', '--from', '12h'])).stdout);
    // Whole hours starting after 12 hours ago: 11, or 12 when the clock is exactly on the hour.
    assert.ok([11, 12].includes(json.candles.length));
    assert.deepEqual([json.pair, json.stats.close, json.tickerNote], ['WETH/USDC', 2_323, 'offline']);
    const html = await run(['WETH/USDC', '--output', 'html', '--no-open', '--html-file', join(directory, 'chart.html')]);
    assert.match(html.stdout, /Saved .*chart\.html\./);
    assert.match(readFileSync(join(directory, 'chart.html'), 'utf8'), /"pair":"WETH\/USDC"/);
    await assert.rejects(run(['DAI/USDC']), /No cached download in .* matches DAI\/USDC/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

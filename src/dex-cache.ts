import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { datasetHeader, downloadDataset, MAX_HISTORY_DAYS, priceUnit, type Candle, type DexDataset } from './dex-data.js';
import { GECKO_TIMEFRAMES, type GeckoPool, type GeckoTerminalClient, type Timeframe } from './providers/geckoterminal.js';
import type { CandleFormat } from './candle-files.js';

// dex-data show reads what dex-data download saved, like a cache, and downloads only what is missing.

/** A saved download: its metadata and the data file beside it. */
export interface CachedFile { path: string; format: CandleFormat; meta: DexDataset }

/** Every dex-data download in a folder, found by its metadata (.meta.json, or the meta block of a .json file). Unreadable files are skipped. */
export async function listCachedFiles(directory: string): Promise<CachedFile[]> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const files: CachedFile[] = [];
  for (const name of names) {
    try {
      if (name.endsWith('.meta.json')) {
        const dataName = name.slice(0, -'.meta.json'.length);
        const format = dataName.split('.').pop() as CandleFormat;
        if (!names.includes(dataName) || !['csv', 'jsonl', 'parquet'].includes(format)) continue;
        const meta = JSON.parse(await readFile(join(directory, name), 'utf8')) as DexDataset;
        if (meta.source === 'geckoterminal' && meta.pool?.address) files.push({ path: join(directory, dataName), format, meta });
      } else if (name.endsWith('.json')) {
        const body = JSON.parse(await readFile(join(directory, name), 'utf8')) as { meta?: DexDataset; candles?: unknown };
        if (body.meta?.source === 'geckoterminal' && body.meta.pool?.address && Array.isArray(body.candles)) files.push({ path: join(directory, name), format: 'json', meta: body.meta });
      }
    } catch { /* Not a dex-data file, or damaged: leave it out. */ }
  }
  return files;
}

const number = (value: unknown) => typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value as number;
const toCandle = (row: Record<string, unknown>): Candle | undefined => {
  const candle = { timestamp: number(row.timestamp), open: number(row.open), high: number(row.high), low: number(row.low), close: number(row.close), volume: number(row.volume), filled: row.filled === true || row.filled === 'true' };
  return [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) && candle.open > 0 && candle.close > 0 ? candle : undefined;
};

/** The candles of a saved file, in any of the four formats; rows that do not parse are skipped. */
export async function readCachedCandles(file: CachedFile): Promise<Candle[]> {
  let rows: Array<Record<string, unknown>>;
  if (file.format === 'parquet') rows = await parquetReadObjects({ file: await asyncBufferFromFile(file.path) }) as Array<Record<string, unknown>>;
  else {
    const text = await readFile(file.path, 'utf8');
    if (file.format === 'json') rows = (JSON.parse(text) as { candles: Array<Record<string, unknown>> }).candles;
    else if (file.format === 'jsonl') rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    else {
      const [header, ...lines] = text.trim().split('\n');
      const columns = header!.split(',');
      rows = lines.map((line) => Object.fromEntries(line.split(',').map((value, i) => [columns[i]!, value])));
    }
  }
  return rows.map(toCandle).filter((candle): candle is Candle => candle !== undefined);
}

/** The price series a file holds: its pool and unit. Files match when they price the same token in the same unit in the same pool. */
export interface SeriesKey { chainId: number; address: string; priced: string; quote?: string }
const lower = (text?: string) => text?.toLowerCase();
const sameSeries = (meta: DexDataset, key: SeriesKey) => meta.pool.chainId === key.chainId && lower(meta.pool.address) === lower(key.address)
  && lower(meta.pricedToken?.address) === lower(key.priced) && lower(meta.quoteToken?.address) === lower(key.quote);

/** Group finer candles into `step`-second candles: first open, highest high, lowest low, last close, summed volume; filled only when every part was. */
export function resampleCandles(candles: Candle[], step: number): Candle[] {
  const out: Candle[] = [];
  for (const candle of [...candles].sort((a, b) => a.timestamp - b.timestamp)) {
    const bucket = Math.floor(candle.timestamp / step) * step;
    const current = out.at(-1);
    if (current?.timestamp === bucket) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
      current.filled &&= candle.filled;
    } else out.push({ ...candle, timestamp: bucket });
  }
  return out;
}

type Span = [number, number];
/** The parts of [start, end) not covered by any span. */
export function uncovered(start: number, end: number, spans: Span[]): Span[] {
  const gaps: Span[] = [];
  let cursor = start;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to <= cursor) continue;
    if (from >= end) break;
    if (from > cursor) gaps.push([cursor, Math.min(from, end)]);
    cursor = Math.max(cursor, to);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps;
}

export interface ShowData {
  candles: Candle[];
  /** Cached files read, and the files downloaded to fill the gaps. */
  cached: CachedFile[];
  downloaded: string[];
  /** Ranges no source could provide (older than GeckoTerminal's 180 days and not in the cache, or offline). */
  unavailable: Span[];
  /** Quiet periods filled with the previous close to join the pieces. */
  filled: number;
  requests: number;
}

/**
 * The candles of [start, end) for one series at `timeframe`, from cached downloads first. Files at the same timeframe
 * are used as they are; finer ones whose size divides it are grouped into it, keeping only periods they fully cover.
 * Gaps within GeckoTerminal's 180 days are downloaded and saved beside the cache (unless `offline`), so the cache
 * grows. Where pieces overlap, the most recent download wins and real candles beat filled ones. Quiet periods between
 * candles are filled with the previous close, as downloads do.
 */
export async function loadShowData(options: {
  directory: string; key: SeriesKey; timeframe: Timeframe; start: number; end: number; now: number; offline: boolean; refresh: boolean;
  client?: GeckoTerminalClient; pool?: GeckoPool; unit?: ReturnType<typeof priceUnit>; pair: string; onProgress?: (text: string) => void;
}): Promise<ShowData> {
  const step = GECKO_TIMEFRAMES[options.timeframe].seconds;
  const all = (await listCachedFiles(options.directory)).filter((file) => sameSeries(file.meta, options.key));
  const usable = all.filter((file) => {
    const size = GECKO_TIMEFRAMES[file.meta.timeframe]?.seconds;
    return size !== undefined && size <= step && step % size === 0;
  });
  // Older downloads first, so newer ones overwrite them; real candles always beat filled ones.
  usable.sort((a, b) => Date.parse(a.meta.downloadedAt) - Date.parse(b.meta.downloadedAt));
  const merged = new Map<number, Candle>();
  const covered: Span[] = [];
  const put = (candle: Candle) => { const seen = merged.get(candle.timestamp); if (!seen || !candle.filled || seen.filled) merged.set(candle.timestamp, candle); };
  const add = (candles: Candle[], from: number, to: number, size: number) => {
    // Only whole periods of the target size count from a finer file.
    const first = Math.ceil(from / step) * step;
    const last = Math.floor(to / step) * step;
    if (last <= first) return;
    covered.push([first, last]);
    for (const candle of size === step ? candles : resampleCandles(candles, step)) if (candle.timestamp >= first && candle.timestamp < last && candle.timestamp >= options.start && candle.timestamp < options.end) put(candle);
  };
  for (const file of usable) {
    const from = Date.parse(file.meta.from) / 1000;
    const to = Date.parse(file.meta.to) / 1000;
    if (to <= options.start || from >= options.end) continue;
    options.onProgress?.(`Reading ${file.path}…`);
    add(await readCachedCandles(file), from, to, GECKO_TIMEFRAMES[file.meta.timeframe].seconds);
  }
  const used = usable.filter((file) => Date.parse(file.meta.to) / 1000 > options.start && Date.parse(file.meta.from) / 1000 < options.end);

  // Download what is missing and still available; --refresh downloads all of the available range again.
  const oldest = Math.ceil((options.now - MAX_HISTORY_DAYS * 86_400 + 60) / step) * step;
  const gaps = uncovered(options.start, options.end, options.refresh ? [] : covered);
  const unavailable: Span[] = [];
  const downloaded: string[] = [];
  let requests = 0;
  for (const [from, to] of gaps) {
    const start = Math.max(from, oldest);
    if (start > from) unavailable.push([from, Math.min(start, to)]);
    if (start >= to) continue;
    if (options.offline || !options.client || !options.pool || !options.unit) { unavailable.push([start, to]); continue; }
    const header = datasetHeader(options.pool, options.unit, options.pair, options.timeframe, start, to, 'forward');
    const result = await downloadDataset(options.client, options.pool, options.unit, header, start, to, { directory: options.directory, format: 'csv', force: true },
      (pages) => options.onProgress?.(`Downloading ${options.pair} ${options.timeframe} candles: ${pages} request${pages === 1 ? '' : 's'}…`));
    requests += result.dataset.requests;
    downloaded.push(result.files[0]!);
    for (const candle of result.candles) merged.set(candle.timestamp, candle);
  }

  // Join the pieces: fill quiet periods between candles with the previous close, as downloads do.
  const sorted = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
  const candles: Candle[] = [];
  let filled = 0;
  const inGap = (time: number) => unavailable.some(([from, to]) => time >= from && time < to);
  for (const candle of sorted) {
    const previous = candles.at(-1);
    if (previous) {
      for (let time = previous.timestamp + step; time < candle.timestamp; time += step) {
        if (inGap(time)) continue;
        const close = candles.at(-1)!.close;
        candles.push({ timestamp: time, open: close, high: close, low: close, close, volume: 0, filled: true });
        filled += 1;
      }
    }
    candles.push(candle);
  }
  return { candles, cached: used, downloaded, unavailable: unavailable.filter(([from, to]) => to > from), filled, requests };
}

/** The pools saved downloads cover, for finding a pair without the network: newest download first. */
export async function cachedPools(directory: string): Promise<CachedFile[]> {
  return (await listCachedFiles(directory)).sort((a, b) => Date.parse(b.meta.downloadedAt) - Date.parse(a.meta.downloadedAt));
}

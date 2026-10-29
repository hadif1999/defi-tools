import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parquetWriteBuffer } from 'hyparquet-writer';

// Shared by dex-data and market-data: time options, range alignment, and candle files with their metadata.

export const CANDLE_FORMATS = ['csv', 'json', 'jsonl', 'parquet'] as const;
export type CandleFormat = typeof CANDLE_FORMATS[number];
export const FILL_MODES = ['forward', 'none'] as const;
export type FillMode = typeof FILL_MODES[number];
/** A close this far from the previous one (as a fraction) is reported as a jump worth checking. */
export const JUMP = 0.5;

/** Parse a time: now, a duration ago (30d, 12h, 2w), a date (2026-10-01), a date and time (2026-10-01T12:00Z), or unix seconds. */
export function parseTime(value: string, optionName: string, now = Date.now()): number {
  const text = value.trim().toLowerCase();
  if (text === 'now') return Math.floor(now / 1000);
  const ago = /^(\d+(?:\.\d+)?)\s*(h|d|w)$/.exec(text);
  if (ago) return Math.floor(now / 1000 - Number(ago[1]) * { h: 3_600, d: 86_400, w: 604_800 }[ago[2] as 'h' | 'd' | 'w']);
  if (/^\d{9,10}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?)?$/.test(text)) {
    // Dates and times without a zone are UTC, like the timestamps in the files.
    const iso = text.replace(' ', 't').toUpperCase();
    const ms = Date.parse(/T/.test(iso) && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? `${iso}Z` : iso);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new Error(`${optionName} "${value}" is not a time. Use now, a duration ago (30d, 12h, 2w), a UTC date (2026-10-01), a date and time (2026-10-01T12:00), or unix seconds.`);
}

export const isoTime = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
/** 20261029-1200, for file names. */
export const fileStamp = (seconds: number): string => isoTime(seconds).slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
/** A symbol made safe for a file name. */
export const safeName = (text: string): string => text.replace(/[^A-Za-z0-9.]+/g, '').slice(0, 20) || 'token';

/**
 * The candle periods [start, end) to download, aligned to `step` seconds (shifted by `offset`, e.g. weeks start on
 * Monday). A period counts when it starts inside the range; without `includePartial`, only periods that have ended.
 * `oldest`, when given, is the earliest time the source serves, and `tooOld` explains it.
 */
export function alignRange(step: number, label: string, from: number, to: number, now: number, includePartial: boolean,
  limit?: { oldest: number; tooOld: string }, offset = 0): { start: number; end: number } {
  if (from >= to) throw new Error('--from must be earlier than --to.');
  if (limit && from < limit.oldest - 60) throw new Error(limit.tooOld);
  const up = (time: number) => Math.ceil((time - offset) / step) * step + offset;
  const start = up(Math.max(from, limit?.oldest ?? from));
  const end = up(includePartial ? to : Math.min(to, now - step + 1));
  if (end <= start) throw new Error(`No complete ${label} candle fits between --from and --to. Widen the range${includePartial ? '' : ' or add --include-partial'}.`);
  return { start, end };
}

/** A data column after time and timestamp: prices and volumes are doubles, counts integers, flags booleans. */
export interface CandleColumn<T> { name: keyof T & string; type: 'DOUBLE' | 'INT32' | 'BOOLEAN' }

/** Encode rows in a format. JSON holds the metadata too; other formats get it in a .meta.json file beside them (Parquet also in its footer). */
export function encodeRows<T extends { timestamp: number }>(rows: T[], columns: CandleColumn<T>[], meta: object, format: CandleFormat): Uint8Array | string {
  const record = (row: T) => ({ time: isoTime(row.timestamp), timestamp: row.timestamp, ...Object.fromEntries(columns.map((column) => [column.name, row[column.name]])) });
  const names = ['time', 'timestamp', ...columns.map((column) => column.name)];
  if (format === 'csv') return `${names.join(',')}\n${rows.map((row) => Object.values(record(row)).map(String).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
  if (format === 'jsonl') return rows.map((row) => JSON.stringify(record(row))).join('\n') + (rows.length ? '\n' : '');
  if (format === 'json') return `${JSON.stringify({ meta, candles: rows.map(record) }, null, 2)}\n`;
  return new Uint8Array(parquetWriteBuffer({
    columnData: [
      { name: 'time', data: rows.map((row) => new Date(row.timestamp * 1000)), type: 'TIMESTAMP' },
      { name: 'timestamp', data: rows.map((row) => BigInt(row.timestamp)), type: 'INT64' },
      ...columns.map((column) => ({ name: column.name, data: rows.map((row) => row[column.name]), type: column.type })),
    ],
    kvMetadata: [{ key: 'defi-tool', value: JSON.stringify(meta) }],
  }));
}

/** Write the data file (and, except for JSON, its .meta.json); refuses to replace files unless `force`. Returns the paths written. */
export async function writeRows<T extends { timestamp: number }>(directory: string, fileName: string, rows: T[], columns: CandleColumn<T>[], meta: object, format: CandleFormat, force: boolean): Promise<string[]> {
  const path = join(directory, fileName);
  const metaPath = `${path}.meta.json`;
  const paths = format === 'json' ? [path] : [path, metaPath];
  const existing = paths.find((item) => existsSync(item));
  if (existing && !force) throw new Error(`${existing} already exists. Add --force to replace it, or choose another --out-dir.`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, encodeRows(rows, columns, meta, format));
  if (format !== 'json') await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return paths;
}

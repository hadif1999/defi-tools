import type { Candle } from './dex-data.js';
import { formatNumber, palette } from './output.js';

// A candlestick chart drawn with box characters: each terminal row holds two price levels (top and bottom half),
// bodies are heavy lines and wicks light ones, with a price axis, time labels, volume bars and the live price.

export interface ChartOptions {
  width: number;
  /** Rows for the candles; volume rows come on top of this. */
  height: number;
  volumeHeight: number;
  color: boolean;
  /** The live price, drawn as a dotted line across the chart and marked on the axis. */
  live?: number;
}

/** Merge runs of `size` consecutive candles into one, so a long range fits the terminal's width. */
export function compressCandles(candles: Candle[], size: number): Candle[] {
  if (size <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += size) {
    const group = candles.slice(i, i + size);
    out.push({
      timestamp: group[0]!.timestamp, open: group[0]!.open, close: group.at(-1)!.close,
      high: Math.max(...group.map((candle) => candle.high)), low: Math.min(...group.map((candle) => candle.low)),
      volume: group.reduce((sum, candle) => sum + candle.volume, 0), filled: group.every((candle) => candle.filled),
    });
  }
  return out;
}

// Which halves of a cell the body and the wick cover → the character that draws them.
function glyph(bodyTop: boolean, bodyBottom: boolean, wickTop: boolean, wickBottom: boolean): string {
  if (bodyTop && bodyBottom) return '┃';
  if (bodyTop) return wickBottom ? '╿' : '╹';
  if (bodyBottom) return wickTop ? '╽' : '╻';
  if (wickTop && wickBottom) return '│';
  if (wickTop) return '╵';
  if (wickBottom) return '╷';
  return ' ';
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Time labels short enough for the span: times within two days, date and time within two weeks, dates within a year, months beyond. */
function timeLabel(seconds: number, span: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  if (span <= 2 * 86_400) return iso.slice(11, 16);
  if (span <= 14 * 86_400) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  if (span <= 366 * 86_400) return iso.slice(5, 10);
  return iso.slice(0, 7);
}

/** The chart as lines of text, and how many candles each column merges. */
export function renderCandleChart(input: Candle[], options: ChartOptions): { lines: string[]; merged: number } {
  const paint = palette(options.color);
  const gray = (text: string) => options.color ? `\x1b[90m${text}\x1b[0m` : text;
  const yellow = (text: string) => options.color ? `\x1b[33m${text}\x1b[0m` : text;
  let top = Math.max(...input.map((candle) => candle.high), options.live ?? -Infinity);
  let bottom = Math.min(...input.map((candle) => candle.low), options.live ?? Infinity);
  if (!(top > bottom)) { top *= 1.005; bottom *= 0.995; }
  const labelWidth = Math.max(...[top, bottom, options.live ?? top].map((price) => formatNumber(price).length)) + 2;
  const plotWidth = Math.max(10, options.width - labelWidth - 1);
  // Merge candles when there are more than columns; spread them evenly across the width when there are fewer.
  const merged = Math.max(1, Math.ceil(input.length / plotWidth));
  const candles = compressCandles(input, merged);
  const x = (i: number) => candles.length === 1 ? Math.floor(plotWidth / 2) : Math.round(i * (plotWidth - 1) / (candles.length - 1));
  const levels = options.height * 2;
  const level = (price: number) => Math.round((top - price) / (top - bottom) * (levels - 1));
  const liveRow = options.live === undefined ? undefined : Math.floor(level(options.live) / 2);
  const tint = (candle: Candle) => candle.filled ? gray : candle.close >= candle.open ? paint.green : paint.red;

  // A grid of cells, each a character and its color; empty cells on the live price's row get the dotted line.
  const grid: string[][] = Array.from({ length: options.height }, (_, row) => Array.from({ length: plotWidth }, () => row === liveRow ? yellow('┈') : ' '));
  candles.forEach((candle, i) => {
    const [high, low, bodyTop, bodyBottom] = [level(candle.high), level(candle.low), level(Math.max(candle.open, candle.close)), level(Math.min(candle.open, candle.close))];
    for (let row = Math.floor(high / 2); row <= Math.floor(low / 2); row += 1) {
      const inBody = (half: number) => half >= bodyTop && half <= bodyBottom;
      const inWick = (half: number) => half >= high && half <= low;
      const mark = glyph(inBody(row * 2), inBody(row * 2 + 1), inWick(row * 2), inWick(row * 2 + 1));
      if (mark !== ' ') grid[row]![x(i)] = tint(candle)(mark);
    }
  });
  const axisEvery = Math.max(2, Math.round(options.height / 6));
  const lines = grid.map((cells, row) => {
    const price = top - (row * 2 + 0.5) / (levels - 1) * (top - bottom);
    const label = row === liveRow ? yellow(paint.bold(`◀ ${formatNumber(options.live)}`)) : row % axisEvery === 0 || row === options.height - 1 ? gray(`┤ ${formatNumber(price)}`) : gray('│');
    return `${cells.join('')} ${label}`;
  });

  if (options.volumeHeight > 0) {
    const most = Math.max(...candles.map((candle) => candle.volume), 0);
    lines.push(gray(`${'─'.repeat(plotWidth)} ┤ volume`));
    const bars: string[][] = Array.from({ length: options.volumeHeight }, () => Array.from({ length: plotWidth }, () => ' '));
    candles.forEach((candle, i) => {
      const eighths = most > 0 ? Math.round(candle.volume / most * options.volumeHeight * 8) : 0;
      for (let row = 0; row < options.volumeHeight; row += 1) {
        const rest = eighths - (options.volumeHeight - 1 - row) * 8;
        if (rest > 0) bars[row]![x(i)] = tint(candle)(rest >= 8 ? '█' : BARS[rest - 1]!);
      }
    });
    lines.push(...bars.map((cells) => cells.join('')));
  }

  // Time labels under their candles, spaced so they never collide.
  const span = (candles.at(-1)?.timestamp ?? 0) - (candles[0]?.timestamp ?? 0);
  let axis = '';
  candles.forEach((candle, i) => {
    const text = timeLabel(candle.timestamp, span);
    const at = x(i);
    if (at >= (axis.length ? axis.length + 3 : 0) && at + text.length <= plotWidth) axis = axis.padEnd(at) + text;
  });
  lines.push(gray(axis));
  return { lines, merged };
}

/** Text without color codes, for measuring. */
export const visible = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

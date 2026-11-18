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
  /** Prices to mark with a dashed line and a label on the axis, e.g. a position's range limits and entry. */
  levels?: ChartLevel[];
  /** A price band shaded behind the candles, e.g. a position's range. */
  band?: [number, number];
  /** Events marked on a row under the candles, at their time. */
  marks?: Array<{ timestamp: number; glyph: string; color: TermColor }>;
}

export type TermColor = 'green' | 'red' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray';
export interface ChartLevel { price: number; label: string; color: TermColor }

const CODES: Record<TermColor, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
/** Text in a terminal color, or plain without color. */
export const colorize = (color: TermColor, enabled: boolean) => (text: string) => enabled ? `\x1b[${CODES[color]}m${text}\x1b[0m` : text;

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
  const levels = options.levels ?? [];
  const extra = [options.live, ...levels.map((level) => level.price), ...(options.band ?? [])].filter((value): value is number => value !== undefined && Number.isFinite(value));
  let top = Math.max(...input.map((candle) => candle.high), ...extra);
  let bottom = Math.min(...input.map((candle) => candle.low), ...extra);
  if (!(top > bottom)) { top *= 1.005; bottom *= 0.995; }
  // A little room above and below, so lines at the edges stay readable.
  if (levels.length) { const pad = (top - bottom) * 0.03; top += pad; bottom -= pad; }
  const labelWidth = Math.max(...[top, bottom, options.live ?? top].map((price) => formatNumber(price).length), ...levels.map((level) => level.label.length + formatNumber(level.price).length + 1)) + 2;
  const plotWidth = Math.max(10, options.width - labelWidth - 1);
  // Merge candles when there are more than columns; spread them evenly across the width when there are fewer.
  const merged = Math.max(1, Math.ceil(input.length / plotWidth));
  const candles = compressCandles(input, merged);
  const x = (i: number) => candles.length === 1 ? Math.floor(plotWidth / 2) : Math.round(i * (plotWidth - 1) / (candles.length - 1));
  const halves = options.height * 2;
  const level = (price: number) => Math.round((top - price) / (top - bottom) * (halves - 1));
  const liveRow = options.live === undefined ? undefined : Math.floor(level(options.live) / 2);
  const levelRows = new Map<number, ChartLevel[]>();
  for (const item of levels) { const row = Math.floor(level(item.price) / 2); levelRows.set(row, [...(levelRows.get(row) ?? []), item]); }
  const band = options.band && [Math.floor(level(Math.max(...options.band)) / 2), Math.floor(level(Math.min(...options.band)) / 2)];
  const tint = (candle: Candle) => candle.filled ? gray : candle.close >= candle.open ? paint.green : paint.red;

  // A grid of cells, each a character and its color; empty cells on the live price's row get the dotted line.
  const background = (row: number, column: number) => {
    const line = levelRows.get(row);
    if (row === liveRow) return yellow('┈');
    if (line) return colorize(line[0]!.color, options.color)('╌');
    if (band && row >= band[0]! && row <= band[1]!) return column % 2 ? ' ' : gray('·');
    return ' ';
  };
  const grid: string[][] = Array.from({ length: options.height }, (_, row) => Array.from({ length: plotWidth }, (_, column) => background(row, column)));
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
    const price = top - (row * 2 + 0.5) / (halves - 1) * (top - bottom);
    const marked = levelRows.get(row);
    const label = row === liveRow ? yellow(paint.bold(`◀ ${formatNumber(options.live)}`))
      : marked ? colorize(marked[0]!.color, options.color)(`◀ ${marked.map((item) => item.label).join('/')} ${formatNumber(marked[0]!.price)}`)
        : row % axisEvery === 0 || row === options.height - 1 ? gray(`┤ ${formatNumber(price)}`) : gray('│');
    return `${cells.join('')} ${label}`;
  });

  // Event marks on their own row, under the candle they happened in.
  if (options.marks?.length && candles.length) {
    const row = Array.from({ length: plotWidth }, () => ' ');
    for (const mark of options.marks) {
      let index = -1;
      candles.forEach((candle, i) => { if (candle.timestamp <= mark.timestamp) index = i; });
      if (index >= 0 && (index < candles.length - 1 || mark.timestamp < candles.at(-1)!.timestamp + (candles.length > 1 ? candles.at(-1)!.timestamp - candles.at(-2)!.timestamp : 86_400))) row[x(index)] = colorize(mark.color, options.color)(mark.glyph);
    }
    lines.push(`${row.join('')} ${gray('│ events')}`);
  }

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

export interface LineSeries { points: Array<[number, number]>; color: TermColor; dashed?: boolean }

/**
 * A line chart drawn in braille dots (2×4 per character), for curves such as a position's value against price.
 * x and y are linear; vertical markers label prices along the x axis.
 */
export function renderLineChart(series: LineSeries[], options: { width: number; height: number; color: boolean; markers?: Array<{ x: number; label: string; color: TermColor }>; yFormat?: (value: number) => string; xFormat?: (value: number) => string }): string[] {
  const gray = colorize('gray', options.color);
  const yFormat = options.yFormat ?? formatNumber;
  const xFormat = options.xFormat ?? formatNumber;
  const all = series.flatMap((line) => line.points);
  const [xMin, xMax] = [Math.min(...all.map(([x]) => x)), Math.max(...all.map(([x]) => x))];
  let [yMin, yMax] = [Math.min(...all.map(([, y]) => y)), Math.max(...all.map(([, y]) => y))];
  if (!(yMax > yMin)) { yMax += 1; yMin -= 1; }
  const pad = (yMax - yMin) * 0.05;
  [yMin, yMax] = [yMin - pad, yMax + pad];
  const labelWidth = Math.max(yFormat(yMax).length, yFormat(yMin).length) + 2;
  const width = Math.max(10, options.width - labelWidth - 1);
  const [dotsX, dotsY] = [width * 2, options.height * 4];
  const cells = Array.from({ length: options.height }, () => Array.from({ length: width }, () => ({ bits: 0, color: undefined as TermColor | undefined })));
  const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  const dot = (px: number, py: number, color: TermColor) => {
    if (px < 0 || py < 0 || px >= dotsX || py >= dotsY) return;
    const cell = cells[Math.floor(py / 4)]![Math.floor(px / 2)]!;
    cell.bits |= BIT[py % 4]![px % 2]!;
    cell.color = color;
  };
  const toX = (x: number) => Math.round((x - xMin) / (xMax - xMin || 1) * (dotsX - 1));
  const toY = (y: number) => Math.round((yMax - y) / (yMax - yMin) * (dotsY - 1));
  // Markers first, as dotted columns, so the curves draw over them.
  for (const marker of options.markers ?? []) { const px = toX(marker.x); for (let py = 0; py < dotsY; py += 3) dot(px, py, marker.color); }
  for (const line of series) {
    let count = 0;
    line.points.forEach(([x, y], i) => {
      if (!i) return;
      const [x0, y0, x1, y1] = [toX(line.points[i - 1]![0]), toY(line.points[i - 1]![1]), toX(x), toY(y)];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let k = 0; k <= steps; k += 1) { count += 1; if (!line.dashed || count % 4 < 2) dot(Math.round(x0 + (x1 - x0) * k / steps), Math.round(y0 + (y1 - y0) * k / steps), line.color); }
    });
  }
  const axisEvery = Math.max(2, Math.round(options.height / 4));
  const lines = cells.map((row, r) => {
    const text = row.map((cell) => cell.bits ? (cell.color ? colorize(cell.color, options.color) : String)(String.fromCharCode(0x2800 + cell.bits)) : ' ').join('');
    const value = yMax - (r * 4 + 1.5) / (dotsY - 1) * (yMax - yMin);
    return `${text} ${r % axisEvery === 0 || r === options.height - 1 ? gray(`┤ ${yFormat(value)}`) : gray('│')}`;
  });
  // The x axis: markers' labels where they fit, then the ends.
  const axis = Array.from({ length: width }, () => ' ');
  const place = (column: number, text: string, color?: TermColor) => {
    const start = Math.max(0, Math.min(width - text.length, column - Math.floor(text.length / 2)));
    if (axis.slice(Math.max(0, start - 1), start + text.length + 1).some((char) => char !== ' ')) return;
    [...text].forEach((char, k) => { axis[start + k] = color ? colorize(color, options.color)(char) : gray(char); });
  };
  for (const marker of options.markers ?? []) place(Math.floor(toX(marker.x) / 2), marker.label, marker.color);
  place(0, xFormat(xMin));
  place(width - 1, xFormat(xMax));
  lines.push(axis.join(''));
  return lines;
}

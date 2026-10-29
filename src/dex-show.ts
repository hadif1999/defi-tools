import { spawn } from 'node:child_process';
import type { Candle } from './dex-data.js';
import type { Ticker } from './dex-ticker.js';
import { CHAINS } from './types.js';
import { formatNumber, formatTickerLine, formatUsd, palette } from './output.js';
import { renderCandleChart } from './terminal-chart.js';
import { isoTime } from './candle-files.js';

// dex-data show: summary figures, the terminal view, and opening the HTML view in a browser.

export interface ShowStats {
  open: number;
  close: number;
  changePct: number;
  high: number;
  highAt: number;
  low: number;
  lowAt: number;
  volume: number;
  candles: number;
  filled: number;
  /** Standard deviation of log returns between closes, annualized, in percent. */
  volatilityPct?: number;
  first: number;
  last: number;
}

/** Figures for the whole range shown. Undefined when there are no candles. */
export function showStats(candles: Candle[], step: number): ShowStats | undefined {
  if (!candles.length) return undefined;
  const high = candles.reduce((best, candle) => candle.high > best.high ? candle : best);
  const low = candles.reduce((best, candle) => candle.low < best.low ? candle : best);
  const returns = candles.slice(1).map((candle, i) => Math.log(candle.close / candles[i]!.close)).filter(Number.isFinite);
  const mean = returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1);
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return {
    open: candles[0]!.open, close: candles.at(-1)!.close, changePct: (candles.at(-1)!.close / candles[0]!.open - 1) * 100,
    high: high.high, highAt: high.timestamp, low: low.low, lowAt: low.timestamp,
    volume: candles.reduce((sum, candle) => sum + candle.volume, 0), candles: candles.length, filled: candles.filter((candle) => candle.filled).length,
    volatilityPct: returns.length > 1 ? Math.sqrt(variance * (365 * 86_400 / step)) * 100 : undefined,
    first: candles[0]!.timestamp, last: candles.at(-1)!.timestamp,
  };
}

export interface ShowView {
  pair: string;
  poolLabel: string;
  chainId: number;
  address: string;
  priceUnit: string;
  volumeUnit: string;
  timeframe: string;
  step: number;
  candles: Candle[];
  stats?: ShowStats;
  ticker?: Ticker;
  /** Why there is no live ticker (offline, or the request failed). */
  tickerNote?: string;
  sources: { cached: string[]; downloaded: string[]; unavailable: Array<[number, number]>; requests: number };
}

/** $12.9M in USD, 12.9M USDC in a token. */
export const formatVolume = (value: number, unit: string): string => unit === 'USD' ? formatUsd(value) : `${formatUsd(value).replace('$', '')} ${unit}`;
const day = (seconds: number) => isoTime(seconds).slice(0, 16).replace('T', ' ');
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

/** The terminal view: live ticker, title, candlestick chart with volume, range figures, and where the data came from. */
export function renderShow(view: ShowView, size: { width: number; height: number; volume: boolean; color: boolean }): string {
  const paint = palette(size.color);
  const out: string[] = [];
  out.push(view.ticker ? formatTickerLine(view.ticker, size.color) : paint.dim(`Live price unavailable: ${view.tickerNote ?? 'unknown reason'}.`));
  const chain = CHAINS[view.chainId as keyof typeof CHAINS]?.name ?? String(view.chainId);
  out.push(`${paint.bold(view.pair)}  ${paint.dim(`${view.poolLabel} · ${chain} · ${view.address.slice(0, 6)}…${view.address.slice(-4)} · ${view.priceUnit}`)}`);
  if (!view.stats) {
    out.push('', 'No candles in this range. Widen --from/--to, or drop --offline to download them.');
    return out.join('\n');
  }
  const volumeHeight = size.volume ? Math.max(2, Math.round(size.height / 6)) : 0;
  const chartHeight = Math.max(6, size.height - volumeHeight - 9);
  const { lines, merged } = renderCandleChart(view.candles, { width: size.width, height: chartHeight, volumeHeight, color: size.color, live: view.ticker?.price });
  const shown = merged > 1 ? `${view.timeframe} candles, ${merged} per column to fit` : `${view.timeframe} candles`;
  out.push(paint.dim(`${shown} · ${day(view.stats.first)} – ${day(view.stats.last + view.step)} UTC`), '', ...lines, '');
  const stats = view.stats;
  const tint = stats.changePct >= 0 ? paint.green : paint.red;
  out.push([
    `Change ${tint(signed(stats.changePct))}`,
    `High ${formatNumber(stats.high)} ${paint.dim(day(stats.highAt))}`,
    `Low ${formatNumber(stats.low)} ${paint.dim(day(stats.lowAt))}`,
    `Volume ${formatVolume(stats.volume, view.volumeUnit)}`,
    `Volatility ${stats.volatilityPct === undefined ? '—' : `${stats.volatilityPct.toFixed(0)}%/yr`}`,
    `Candles ${stats.candles.toLocaleString('en-US')}${stats.filled ? paint.dim(` (${stats.filled.toLocaleString('en-US')} quiet, filled)`) : ''}`,
  ].join('   '));
  const sources = [
    view.sources.cached.length ? `${view.sources.cached.length} cached file${view.sources.cached.length === 1 ? '' : 's'}` : undefined,
    view.sources.downloaded.length ? `${view.sources.downloaded.length} new download${view.sources.downloaded.length === 1 ? '' : 's'} (${view.sources.requests} request${view.sources.requests === 1 ? '' : 's'}), saved to the cache` : undefined,
  ].filter(Boolean);
  out.push(paint.dim(`Data: ${sources.join(' + ') || 'none'} · GeckoTerminal`));
  for (const [from, to] of view.sources.unavailable) out.push(paint.dim(`No data for ${day(from)} – ${day(to)} UTC: not in the cache${to <= Date.now() / 1000 - 180 * 86_400 ? ' and older than GeckoTerminal\'s 180 days' : ''}.`));
  return out.join('\n');
}

/** Open a file in the default browser; resolves false when no opener could start (the caller prints the path instead). */
export function openInBrowser(path: string): Promise<boolean> {
  const [command, args] = process.platform === 'darwin' ? ['open', [path]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]] : ['xdg-open', [path]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

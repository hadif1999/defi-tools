import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS } from './types.js';
import type { ShowView } from './dex-show.js';

// The HTML view: a TradingView-style chart workspace in one self-contained page. TradingView's open-source
// Lightweight Charts, the workspace's script and styles (assets/chart/) and the data are all inlined, so the page
// opens offline and can be kept or shared as a single file.

/** The charting library's standalone build, read from node_modules (the package's exports do not list it). */
export function chartLibrary(): string {
  const manifest = createRequire(import.meta.url).resolve('lightweight-charts/package.json');
  return readFileSync(join(dirname(manifest), 'dist', 'lightweight-charts.standalone.production.js'), 'utf8');
}

/** A file in the project's assets/ folder, found from this module whether it runs from src/ or dist/src/. */
export function asset(path: string): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'assets', path))) return readFileSync(join(dir, 'assets', path), 'utf8');
  }
  throw new Error(`The chart asset assets/${path} is missing. Reinstall defi-tool from its project folder.`);
}

/** Text made safe inside a <script> or <style> element. */
export const inline = (text: string) => text.replace(/<\/(script|style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function buildChartHtml(view: ShowView, generatedAt = new Date()): string {
  const chain = CHAINS[view.chainId as keyof typeof CHAINS]?.name ?? String(view.chainId);
  const data = {
    pair: view.pair, pool: view.poolLabel, chain, chainId: view.chainId, address: view.address, priceUnit: view.priceUnit, volumeUnit: view.volumeUnit,
    timeframe: view.timeframe, step: view.step, stats: view.stats,
    candles: view.candles.map((candle) => [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.filled ? 1 : 0]),
    ticker: view.ticker && {
      price: view.ticker.price, change24hPct: view.ticker.change24hPct, high24h: view.ticker.high24h, low24h: view.ticker.low24h,
      volume24hUsd: view.ticker.volume24hUsd, liquidityUsd: view.ticker.liquidityUsd, trades24h: view.ticker.trades24h, updatedAt: view.ticker.updatedAt,
    },
    tickerNote: view.tickerNote,
    sources: { cached: view.sources.cached.length, downloaded: view.sources.downloaded.length, requests: view.sources.requests, unavailable: view.sources.unavailable },
    generatedAt: generatedAt.toISOString(),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${view.pair} · ${view.poolLabel} · ${chain}`)}</title>
<style>${inline(asset('chart/app.css'))}</style>
</head>
<body>
<div class="app" id="app">
  <header class="top">
    <div class="symbol" id="symbol"></div>
    <span class="sep"></span>
    <div class="tf" id="timeframes" role="group" aria-label="Timeframe"></div>
    <span class="sep"></span>
    <button class="btn" type="button" id="type-button" data-menu aria-haspopup="menu" title="Chart type"></button>
    <button class="btn" type="button" id="indicators-button" data-menu aria-haspopup="menu" title="Indicators"></button>
    <span class="sep"></span>
    <button class="btn icon" type="button" id="undo" title="Undo (Ctrl+Z)" aria-label="Undo"></button>
    <button class="btn icon" type="button" id="redo" title="Redo (Ctrl+Y)" aria-label="Redo"></button>
    <span class="grow"></span>
    <div class="live" id="live"></div>
    <span class="sep"></span>
    <button class="btn icon" type="button" id="screenshot" title="Take a screenshot" aria-label="Screenshot"></button>
    <button class="btn icon" type="button" id="fullscreen" title="Full screen" aria-label="Full screen"></button>
    <button class="btn icon" type="button" id="theme" title="Light or dark theme" aria-label="Theme"></button>
    <button class="btn icon" type="button" id="panel" title="Details panel" aria-label="Details panel"></button>
  </header>
  <nav class="tools" id="tools" aria-label="Drawing tools"></nav>
  <div class="chart-area" id="chart-area">
    <div id="chart"></div>
    <canvas id="overlay"></canvas>
    <div id="legend" aria-live="polite"></div>
    <div class="float-bar" id="float-bar" role="toolbar" aria-label="Selected drawing"></div>
    <button class="btn icon to-latest" type="button" id="to-latest" title="Scroll to the latest bar" aria-label="Scroll to the latest bar"></button>
    <input class="text-input" id="text-input" type="text" aria-label="Note text" maxlength="200">
    <div class="toast" id="toast" role="status"></div>
  </div>
  <footer class="bottom">
    <div id="ranges" role="group" aria-label="Visible range"></div>
    <span class="grow"></span>
    <span class="clock" id="clock"></span>
    <span class="sep"></span>
    <button class="btn" type="button" data-scale="percent" title="Percent scale">%</button>
    <button class="btn" type="button" data-scale="log" title="Logarithmic scale">log</button>
    <button class="btn" type="button" id="auto-scale" title="Fit prices to the data">auto</button>
  </footer>
  <aside class="side" id="side" aria-label="Details"></aside>
</div>
<div class="menu" id="type-menu" role="menu"></div>
<div class="menu" id="indicators-menu"></div>
<script type="application/json" id="chart-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${inline(chartLibrary())}</script>
<script>${inline(asset('chart/app.js'))}</script>
</body>
</html>
`;
}

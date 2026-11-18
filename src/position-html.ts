import type { Candle } from './dex-data.js';
import type { PositionDetail } from './position-detail.js';
import { asset, chartLibrary, escapeHtml, inline } from './html-chart.js';

// positions detail --output html: one self-contained report page. The page script (assets/position/app.js) builds
// the KPI tiles, the range gauge, the price chart (Lightweight Charts) with the range band and transactions, the
// value-against-price and impermanent-loss curves, the PnL attribution and the tables from the data embedded here.

export interface PositionHtmlOptions { candles: Candle[]; timeframe: string; step: number; dataNote?: string; plot: boolean }

export function buildPositionHtml(detail: PositionDetail, options: PositionHtmlOptions, generatedAt = new Date()): string {
  const data = {
    detail,
    candles: options.candles.map((candle) => [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.filled ? 1 : 0]),
    timeframe: options.timeframe, step: options.step, dataNote: options.dataNote, plot: options.plot, generatedAt: generatedAt.toISOString(),
  };
  const fee = detail.feeTier === undefined ? '' : ` ${detail.feeTier / 10_000}%`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${detail.pair}${fee} #${detail.id} · Position report`)}</title>
<style>${inline(asset('position/app.css'))}</style>
</head>
<body>
<main class="page" id="page"><noscript>This report needs JavaScript to draw its charts and tables.</noscript></main>
<div class="tip" id="tip" role="tooltip"></div>
<script type="application/json" id="report-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
${options.plot ? `<script>${inline(chartLibrary())}</script>` : ''}
<script>${inline(asset('position/app.js'))}</script>
</body>
</html>
`;
}

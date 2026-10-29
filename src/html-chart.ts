import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CHAINS } from './types.js';
import type { ShowView } from './dex-show.js';

// The HTML view: one self-contained page with TradingView's open-source Lightweight Charts embedded, so it opens
// offline and can be kept or shared as a single file.

/** The charting library's standalone build, read from node_modules (the package's exports do not list it). */
function chartLibrary(): string {
  const manifest = createRequire(import.meta.url).resolve('lightweight-charts/package.json');
  return readFileSync(join(dirname(manifest), 'dist', 'lightweight-charts.standalone.production.js'), 'utf8');
}

/** JSON or script text made safe inside a <script> element. */
const inline = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function buildChartHtml(view: ShowView, generatedAt = new Date()): string {
  const chain = CHAINS[view.chainId as keyof typeof CHAINS]?.name ?? String(view.chainId);
  const data = {
    pair: view.pair, pool: view.poolLabel, chain, address: view.address, priceUnit: view.priceUnit, volumeUnit: view.volumeUnit,
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
  const title = `${view.pair} · ${view.poolLabel} · ${chain}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${view.pair} chart`)}</title>
<style>
:root { --bg:#ffffff; --panel:#f6f7f9; --text:#15181d; --muted:#667085; --line:#e4e7ec; --up:#0f9d74; --down:#e5484d; --accent:#3e63dd; --live:#d97706; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0e1116; --panel:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#262c36; --up:#2fbf8f; --down:#f2555a; --accent:#6e8efb; --live:#f5a524; } }
:root[data-theme="dark"] { --bg:#0e1116; --panel:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#262c36; --up:#2fbf8f; --down:#f2555a; --accent:#6e8efb; --live:#f5a524; }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width:1400px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:12px; min-height:100vh; }
header { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 16px; }
h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:13px; }
.price { font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }
.chip { font-variant-numeric:tabular-nums; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--panel); }
.up { color:var(--up); } .down { color:var(--down); }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.group { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.group button { border:0; background:transparent; color:var(--muted); padding:6px 10px; font:inherit; font-size:13px; cursor:pointer; }
.group button + button { border-left:1px solid var(--line); }
.group button[aria-pressed="true"] { background:var(--panel); color:var(--text); font-weight:600; }
.group button:hover { color:var(--text); }
.spacer { flex:1; }
#chart-wrap { position:relative; flex:1; min-height:420px; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
#chart { position:absolute; inset:0; }
#legend { position:absolute; top:8px; left:12px; z-index:3; pointer-events:none; font-size:12px; font-variant-numeric:tabular-nums; color:var(--muted); background:color-mix(in srgb, var(--bg) 80%, transparent); padding:4px 8px; border-radius:6px; }
#legend b { color:var(--text); font-weight:600; }
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; }
.stat { background:var(--panel); border-radius:10px; padding:10px 12px; }
.stat .k { color:var(--muted); font-size:12px; }
.stat .v { font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; }
.stat .n { color:var(--muted); font-size:12px; }
footer { color:var(--muted); font-size:12px; display:flex; flex-wrap:wrap; gap:4px 16px; }
.note { color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<main>
  <header>
    <h1 id="title"></h1><span class="sub" id="subtitle"></span>
    <span class="spacer"></span>
    <span class="price" id="live-price"></span><span class="chip" id="live-change"></span>
  </header>
  <div class="note" id="ticker-line"></div>
  <div class="toolbar">
    <div class="group" id="timeframes" role="group" aria-label="Timeframe"></div>
    <div class="group" id="ranges" role="group" aria-label="Visible range"></div>
    <span class="spacer"></span>
    <div class="group" role="group" aria-label="Theme"><button id="theme" type="button" aria-pressed="false">Theme</button></div>
  </div>
  <div id="chart-wrap"><div id="legend"></div><div id="chart"></div></div>
  <section class="stats" id="stats" aria-label="Figures for the range shown"></section>
  <footer id="footer"></footer>
</main>
<script>${inline(chartLibrary())}</script>
<script>
const DATA = ${inline(JSON.stringify(data))};
${inline(CLIENT_SCRIPT)}
</script>
</body>
</html>
`;
}

// Runs in the browser. Kept as plain JavaScript in a string, so the page needs nothing but itself.
const CLIENT_SCRIPT = String.raw`
(() => {
  const LC = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (value) => {
    if (value === undefined || value === null || !isFinite(value)) return '—';
    const size = Math.abs(value);
    const opts = size >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : size >= 1 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
    return new Intl.NumberFormat('en-US', opts).format(value);
  };
  const compact = (value) => value === undefined || value === null || !isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const usd = (value) => value === undefined || value === null ? '—' : '$' + compact(value);
  const pct = (value) => value === undefined || value === null || !isFinite(value) ? '—' : (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
  const when = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const volume = (value) => DATA.volumeUnit === 'USD' ? usd(value) : compact(value) + ' ' + DATA.volumeUnit;

  // Header and live ticker.
  $('title').textContent = DATA.pair;
  $('subtitle').textContent = DATA.pool + ' · ' + DATA.chain + ' · ' + DATA.address.slice(0, 6) + '…' + DATA.address.slice(-4) + ' · ' + DATA.priceUnit;
  if (DATA.ticker) {
    $('live-price').textContent = fmt(DATA.ticker.price);
    const change = DATA.ticker.change24hPct;
    $('live-change').textContent = '24h ' + pct(change);
    $('live-change').className = 'chip ' + (change >= 0 ? 'up' : 'down');
    $('ticker-line').textContent = 'Live: 24h high ' + fmt(DATA.ticker.high24h) + ' · low ' + fmt(DATA.ticker.low24h) + ' · volume ' + usd(DATA.ticker.volume24hUsd)
      + ' · liquidity ' + usd(DATA.ticker.liquidityUsd) + (DATA.ticker.trades24h !== undefined ? ' · ' + DATA.ticker.trades24h.toLocaleString('en-US') + ' trades' : '')
      + ' · as of ' + new Date(DATA.ticker.updatedAt).toLocaleString();
  } else {
    $('ticker-line').textContent = 'Live price unavailable' + (DATA.tickerNote ? ': ' + DATA.tickerNote : '') + '.';
  }

  // Candles at the downloaded timeframe; larger timeframes are built here, in the page.
  const base = DATA.candles.map(([time, open, high, low, close, vol, filled]) => ({ time, open, high, low, close, volume: vol, filled: filled === 1 }));
  const SIZES = [['1m', 60], ['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['12h', 43200], ['1d', 86400], ['1w', 604800]];
  const resample = (step) => {
    if (step === DATA.step) return base;
    // Weeks start on Monday (the unix epoch fell on a Thursday).
    const offset = step === 604800 ? 4 * 86400 : 0;
    const out = [];
    for (const candle of base) {
      const bucket = Math.floor((candle.time - offset) / step) * step + offset;
      const last = out[out.length - 1];
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, candle.high); last.low = Math.min(last.low, candle.low);
        last.close = candle.close; last.volume += candle.volume; last.filled = last.filled && candle.filled;
      } else out.push({ ...candle, time: bucket });
    }
    return out;
  };

  const chart = LC.createChart($('chart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: css('--muted'), fontFamily: getComputedStyle(document.body).fontFamily, panes: { separatorColor: css('--line') } },
    grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
    rightPriceScale: { borderColor: css('--line') },
    timeScale: { borderColor: css('--line'), timeVisible: DATA.step < 86400, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { priceFormatter: fmt },
  });
  const candles = chart.addSeries(LC.CandlestickSeries, { upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'), borderVisible: false, priceLineVisible: false });
  const volumes = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'custom', formatter: compact, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false }, 1);
  chart.panes()[1] && chart.panes()[1].setHeight(110);
  if (DATA.ticker) candles.createPriceLine({ price: DATA.ticker.price, color: css('--live'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'live' });

  let current = [];
  const paint = (rows) => {
    const muted = css('--muted');
    candles.setData(rows.map((row) => row.filled ? { ...row, color: muted, wickColor: muted } : row));
    volumes.setData(rows.map((row) => ({ time: row.time, value: row.volume, color: (row.filled ? muted : row.close >= row.open ? css('--up') : css('--down')) + '80' })));
  };
  const show = (step) => {
    current = resample(step);
    paint(current);
    chart.applyOptions({ timeScale: { timeVisible: step < 86400 } });
    chart.timeScale().fitContent();
    renderStats(current, step);
    legend();
  };

  // Hover legend: the candle under the crosshair, or the latest one.
  const legend = (param) => {
    const row = param && param.time !== undefined ? current.find((item) => item.time === param.time) : current[current.length - 1];
    if (!row) { $('legend').textContent = ''; return; }
    const change = (row.close / row.open - 1) * 100;
    $('legend').innerHTML = '<b>' + when(row.time) + ' UTC</b>  O <b>' + fmt(row.open) + '</b>  H <b>' + fmt(row.high) + '</b>  L <b>' + fmt(row.low) + '</b>  C <b>' + fmt(row.close)
      + '</b>  <span class="' + (change >= 0 ? 'up' : 'down') + '">' + pct(change) + '</span>  Vol <b>' + volume(row.volume) + '</b>' + (row.filled ? '  (no trades)' : '');
  };
  chart.subscribeCrosshairMove(legend);

  // Figures for the candles loaded at this timeframe.
  const renderStats = (rows, step) => {
    if (!rows.length) { $('stats').innerHTML = '<div class="stat"><div class="k">No candles</div></div>'; return; }
    const high = rows.reduce((a, b) => b.high > a.high ? b : a);
    const low = rows.reduce((a, b) => b.low < a.low ? b : a);
    const change = (rows[rows.length - 1].close / rows[0].open - 1) * 100;
    const returns = rows.slice(1).map((row, i) => Math.log(row.close / rows[i].close)).filter(isFinite);
    const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const vol = returns.length > 1 ? Math.sqrt(variance * 365 * 86400 / step) * 100 : undefined;
    const filled = rows.filter((row) => row.filled).length;
    const cards = [
      ['Range change', '<span class="' + (change >= 0 ? 'up' : 'down') + '">' + pct(change) + '</span>', when(rows[0].time) + ' → ' + when(rows[rows.length - 1].time + step)],
      ['High', fmt(high.high), when(high.time) + ' UTC'],
      ['Low', fmt(low.low), when(low.time) + ' UTC'],
      ['Volume', volume(rows.reduce((a, b) => a + b.volume, 0)), 'over the range'],
      ['Volatility', vol === undefined ? '—' : vol.toFixed(0) + '%', 'annualized, from closes'],
      ['Candles', rows.length.toLocaleString('en-US'), filled ? filled.toLocaleString('en-US') + ' quiet periods, filled' : 'no gaps'],
    ];
    $('stats').innerHTML = cards.map(([k, v, n]) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="n">' + n + '</div></div>').join('');
  };

  // Timeframes: the downloaded one and every larger one it divides.
  const choices = SIZES.filter(([, size]) => size >= DATA.step && size % DATA.step === 0);
  for (const [label, size] of choices) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.setAttribute('aria-pressed', String(size === DATA.step));
    button.addEventListener('click', () => {
      for (const other of $('timeframes').children) other.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      show(size);
    });
    $('timeframes').appendChild(button);
  }

  // Visible range shortcuts, measured back from the last candle.
  const RANGES = [['1D', 86400], ['1W', 7 * 86400], ['1M', 30 * 86400], ['3M', 90 * 86400], ['All', 0]];
  for (const [label, seconds] of RANGES) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.setAttribute('aria-pressed', String(label === 'All'));
    button.addEventListener('click', () => {
      for (const other of $('ranges').children) other.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      if (!seconds || !current.length) { chart.timeScale().fitContent(); return; }
      const last = current[current.length - 1].time;
      chart.timeScale().setVisibleRange({ from: Math.max(current[0].time, last - seconds), to: last });
    });
    $('ranges').appendChild(button);
  }

  // Theme: follows the system unless toggled; the choice is remembered when storage is available.
  const applyTheme = (theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
    chart.applyOptions({ layout: { textColor: css('--muted'), panes: { separatorColor: css('--line') } }, grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } } });
    candles.applyOptions({ upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down') });
    paint(current);
  };
  let saved = null;
  try { saved = localStorage.getItem('defi-tool-theme'); } catch (e) {}
  $('theme').addEventListener('click', () => {
    const chosen = document.documentElement.getAttribute('data-theme');
    const dark = chosen ? chosen === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    try { localStorage.setItem('defi-tool-theme', next); } catch (e) {}
    applyTheme(next);
  });

  const notes = [];
  if (DATA.sources.cached) notes.push(DATA.sources.cached + ' cached file' + (DATA.sources.cached === 1 ? '' : 's'));
  if (DATA.sources.downloaded) notes.push(DATA.sources.downloaded + ' new download' + (DATA.sources.downloaded === 1 ? '' : 's'));
  for (const [from, to] of DATA.sources.unavailable) notes.push('no data ' + when(from) + ' – ' + when(to));
  $('footer').innerHTML = '<span>Data: GeckoTerminal' + (notes.length ? ' · ' + notes.join(' · ') : '') + '</span><span>Prices in ' + DATA.priceUnit + '; times in UTC; grey candles are periods without trades.</span><span>Made by defi-tool ' + when(Date.parse(DATA.generatedAt) / 1000) + ' UTC · charts by <a href="https://www.tradingview.com/" style="color:inherit">TradingView</a> Lightweight Charts</span>';

  show(DATA.step);
  if (saved) applyTheme(saved);
})();
`;

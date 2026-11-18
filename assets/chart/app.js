// defi-tool chart workspace: a TradingView-style environment around Lightweight Charts.
// Drawings are anchored to (time, price), so they survive zooming, panning, timeframe changes and reloads.
(() => {
  'use strict';
  const LC = window.LightweightCharts;
  const DATA = JSON.parse(document.getElementById('chart-data').textContent);
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  // ---------- Formatting ----------
  const fmt = (value) => {
    if (value === undefined || value === null || !isFinite(value)) return '—';
    const size = Math.abs(value);
    const options = size >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : size >= 1 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
    return new Intl.NumberFormat('en-US', options).format(value);
  };
  const compact = (value) => value === undefined || value === null || !isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  const usd = (value) => value === undefined || value === null ? '—' : '$' + compact(value);
  const pct = (value) => value === undefined || value === null || !isFinite(value) ? '—' : (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
  const signed = (value) => (value >= 0 ? '+' : '−') + fmt(Math.abs(value));
  const when = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const volume = (value) => DATA.volumeUnit === 'USD' ? usd(value) : compact(value) + ' ' + DATA.volumeUnit;
  const span = (seconds) => {
    const s = Math.abs(seconds);
    if (s >= 86400) return Math.floor(s / 86400) + 'd' + (s % 86400 >= 3600 ? ' ' + Math.floor((s % 86400) / 3600) + 'h' : '');
    if (s >= 3600) return Math.floor(s / 3600) + 'h' + (s % 3600 >= 60 ? ' ' + Math.floor((s % 3600) / 60) + 'm' : '');
    return Math.round(s / 60) + 'm';
  };
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- Saved state: settings for every chart, drawings per pool and price unit ----------
  const load = (key, fallback) => { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch (e) { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* Private window: keep it in memory. */ } };
  const SETTINGS_KEY = 'defi-tool:chart:settings';
  const DRAWINGS_KEY = 'defi-tool:chart:drawings:' + DATA.chainId + ':' + DATA.address.toLowerCase() + ':' + DATA.priceUnit;
  const DEFAULT_INDICATORS = {
    volume: { on: true }, ma: { on: false, period: 20 }, ema: { on: false, period: 50 }, bb: { on: false, period: 20, mult: 2 },
    vwap: { on: false }, rsi: { on: false, period: 14 }, macd: { on: false, fast: 12, slow: 26, signal: 9 },
  };
  const stored = load(SETTINGS_KEY, {});
  const settings = {
    theme: stored.theme || null, type: stored.type || 'candles', scale: stored.scale || 'normal', magnet: Boolean(stored.magnet), side: stored.side !== false,
    ind: Object.fromEntries(Object.entries(DEFAULT_INDICATORS).map(([key, value]) => [key, { ...value, ...((stored.ind || {})[key] || {}) }])),
  };
  const saveSettings = () => save(SETTINGS_KEY, settings);
  if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);

  // ---------- Candles and timeframes ----------
  const base = DATA.candles.map(([time, open, high, low, close, vol, filled]) => ({ time, open, high, low, close, volume: vol, filled: filled === 1 }));
  const SIZES = [['1m', 60], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['2h', 7200], ['4h', 14400], ['12h', 43200], ['1D', 86400], ['1W', 604800]];
  const timeframes = SIZES.filter(([, size]) => size >= DATA.step && size % DATA.step === 0);
  const resample = (step) => {
    if (step === DATA.step) return base.map((row) => ({ ...row }));
    const offset = step === 604800 ? 4 * 86400 : 0; // Weeks start on Monday.
    const out = [];
    for (const row of base) {
      const bucket = Math.floor((row.time - offset) / step) * step + offset;
      const last = out[out.length - 1];
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, row.high); last.low = Math.min(last.low, row.low);
        last.close = row.close; last.volume += row.volume; last.filled = last.filled && row.filled;
      } else out.push({ ...row, time: bucket });
    }
    return out;
  };
  const heikinAshi = (rows) => {
    const out = [];
    rows.forEach((row, i) => {
      const close = (row.open + row.high + row.low + row.close) / 4;
      const open = i ? (out[i - 1].open + out[i - 1].close) / 2 : (row.open + row.close) / 2;
      out.push({ ...row, open, close, high: Math.max(row.high, open, close), low: Math.min(row.low, open, close) });
    });
    return out;
  };

  let step = DATA.step;
  let rows = resample(step);
  let times = rows.map((row) => row.time);
  let index = new Map(times.map((time, i) => [time, i]));

  // ---------- Indicators ----------
  const sma = (values, n) => values.map((_, i) => i + 1 < n ? null : values.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n);
  const ema = (values, n) => {
    const out = []; const k = 2 / (n + 1); let prev = null; let seed = 0; let count = 0;
    for (const value of values) {
      if (value === null) { out.push(null); continue; }
      if (prev === null) { seed += value; count += 1; if (count === n) prev = seed / n; out.push(prev); continue; }
      prev = value * k + prev * (1 - k); out.push(prev);
    }
    return out;
  };
  const bollinger = (values, n, mult) => {
    const mid = sma(values, n);
    return values.map((_, i) => {
      if (mid[i] === null) return null;
      const window = values.slice(i + 1 - n, i + 1);
      const sd = Math.sqrt(window.reduce((sum, value) => sum + (value - mid[i]) ** 2, 0) / n);
      return [mid[i] + mult * sd, mid[i], mid[i] - mult * sd];
    });
  };
  const rsi = (values, n) => {
    const out = values.map(() => null); let gain = 0; let loss = 0;
    for (let i = 1; i < values.length; i += 1) {
      const change = values[i] - values[i - 1];
      const up = Math.max(change, 0); const down = Math.max(-change, 0);
      if (i <= n) { gain += up / n; loss += down / n; if (i === n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); continue; }
      gain = (gain * (n - 1) + up) / n; loss = (loss * (n - 1) + down) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  };
  const macd = (values, fast, slow, signal) => {
    const f = ema(values, fast); const s = ema(values, slow);
    const line = values.map((_, i) => f[i] === null || s[i] === null ? null : f[i] - s[i]);
    const sig = ema(line, signal);
    return values.map((_, i) => line[i] === null ? null : [line[i], sig[i], sig[i] === null ? null : line[i] - sig[i]]);
  };
  // VWAP restarts each UTC day, as on exchanges.
  const vwap = (list) => {
    let day = null; let pv = 0; let vol = 0;
    return list.map((row) => {
      const d = Math.floor(row.time / 86400);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      pv += (row.high + row.low + row.close) / 3 * row.volume; vol += row.volume;
      return vol > 0 ? pv / vol : null;
    });
  };
  const IND_COLORS = { ma: '#2962ff', ema: '#ff9800', bb: '#9c27b0', vwap: '#00bcd4', rsi: '#7e57c2', macd: '#2962ff', signal: '#ff6d00' };

  // ---------- Chart ----------
  const chart = LC.createChart($('chart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: css('--muted'), fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11, panes: { separatorColor: css('--line'), separatorHoverColor: css('--accent-soft') } },
    grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
    rightPriceScale: { borderColor: css('--line'), scaleMargins: { top: 0.08, bottom: 0.06 } },
    timeScale: { borderColor: css('--line'), timeVisible: step < 86400, secondsVisible: false, rightOffset: 8, barSpacing: 8 },
    crosshair: { mode: LC.CrosshairMode.Normal, vertLine: { labelBackgroundColor: css('--accent') }, horzLine: { labelBackgroundColor: css('--accent') } },
    localization: { timeFormatter: (time) => when(time) },
  });
  const watermark = LC.createTextWatermark(chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: [{ text: DATA.pair, color: 'rgba(128, 128, 128, 0.12)', fontSize: 56, fontStyle: '600' }, { text: DATA.pool + ' · ' + DATA.chain, color: 'rgba(128, 128, 128, 0.12)', fontSize: 16 }] });

  let main = null;
  let liveLine = null;
  let series = []; // Indicator series: { key, label, color, parts: [series], value: (i) => text }
  const ohlcRows = () => settings.type === 'heikin' ? heikinAshi(rows) : rows;

  // Prices keep about six significant digits on the axis, whatever their size.
  const lastClose = base.length ? base[base.length - 1].close : 1;
  const PRICE_FORMAT = { type: 'custom', formatter: fmt, minMove: Math.pow(10, Math.floor(Math.log10(Math.abs(lastClose) || 1)) - 5) };

  function buildMain() {
    if (main) chart.removeSeries(main);
    const up = css('--up'); const down = css('--down'); const accent = css('--accent'); const muted = css('--muted');
    const type = settings.type;
    if (type === 'line') main = chart.addSeries(LC.LineSeries, { color: accent, lineWidth: 2 });
    else if (type === 'area') main = chart.addSeries(LC.AreaSeries, { lineColor: accent, topColor: accent + '55', bottomColor: accent + '00', lineWidth: 2 });
    else if (type === 'bars') main = chart.addSeries(LC.BarSeries, { upColor: up, downColor: down, thinBars: false });
    else if (type === 'hollow') main = chart.addSeries(LC.CandlestickSeries, { upColor: 'rgba(0, 0, 0, 0)', downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, borderVisible: true });
    else main = chart.addSeries(LC.CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    main.applyOptions({ priceFormat: PRICE_FORMAT });
    if (type === 'line' || type === 'area') main.setData(rows.map((row) => ({ time: row.time, value: row.close })));
    else main.setData(ohlcRows().map((row) => row.filled ? { ...row, color: muted, wickColor: muted, borderColor: muted } : row));
    liveLine = DATA.ticker ? main.createPriceLine({ price: DATA.ticker.price, color: css('--live'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'live' }) : null;
    applyScale();
  }

  function applyScale() {
    const mode = { normal: LC.PriceScaleMode.Normal, log: LC.PriceScaleMode.Logarithmic, percent: LC.PriceScaleMode.Percentage }[settings.scale];
    chart.priceScale('right').applyOptions({ mode });
    for (const button of document.querySelectorAll('[data-scale]')) button.setAttribute('aria-pressed', String(button.dataset.scale === settings.scale));
  }

  const points = (values, pick = (v) => v) => rows.map((row, i) => values[i] === null || values[i] === undefined || pick(values[i]) === null ? { time: row.time } : { time: row.time, value: pick(values[i]) });
  const line = (color, pane, width = 1.5, style) => chart.addSeries(LC.LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: PRICE_FORMAT }, pane);

  function buildIndicators() {
    for (const item of series) for (const part of item.parts) chart.removeSeries(part);
    series = [];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    const ind = settings.ind;
    const closes = rows.map((row) => row.close);
    let pane = 1;
    const heights = [];
    if (ind.volume.on) {
      const part = chart.addSeries(LC.HistogramSeries, { priceFormat: { type: 'custom', formatter: compact, minMove: 0.01 }, priceLineVisible: false, lastValueVisible: false }, pane);
      const muted = css('--muted');
      part.setData(rows.map((row) => ({ time: row.time, value: row.volume, color: (row.filled ? muted : row.close >= row.open ? css('--up') : css('--down')) + '80' })));
      series.push({ key: 'volume', label: 'Vol', color: css('--muted'), parts: [part], value: (i) => volume(rows[i].volume) });
      heights.push([pane, 0.2]); pane += 1;
    }
    if (ind.ma.on) { const v = sma(closes, ind.ma.period); const part = line(IND_COLORS.ma, 0); part.setData(points(v)); series.push({ key: 'ma', label: 'MA ' + ind.ma.period, color: IND_COLORS.ma, parts: [part], value: (i) => fmt(v[i]) }); }
    if (ind.ema.on) { const v = ema(closes, ind.ema.period); const part = line(IND_COLORS.ema, 0); part.setData(points(v)); series.push({ key: 'ema', label: 'EMA ' + ind.ema.period, color: IND_COLORS.ema, parts: [part], value: (i) => fmt(v[i]) }); }
    if (ind.bb.on) {
      const v = bollinger(closes, ind.bb.period, ind.bb.mult);
      const parts = [line(IND_COLORS.bb, 0, 1), line(IND_COLORS.bb, 0, 1, LC.LineStyle.Dotted), line(IND_COLORS.bb, 0, 1)];
      parts.forEach((part, k) => part.setData(points(v, (x) => x[k])));
      series.push({ key: 'bb', label: 'BB ' + ind.bb.period + ' ' + ind.bb.mult, color: IND_COLORS.bb, parts, value: (i) => v[i] ? fmt(v[i][0]) + ' ' + fmt(v[i][1]) + ' ' + fmt(v[i][2]) : '—' });
    }
    if (ind.vwap.on) { const v = vwap(rows); const part = line(IND_COLORS.vwap, 0, 2); part.setData(points(v)); series.push({ key: 'vwap', label: 'VWAP', color: IND_COLORS.vwap, parts: [part], value: (i) => fmt(v[i]) }); }
    if (ind.rsi.on) {
      const v = rsi(closes, ind.rsi.period); const part = line(IND_COLORS.rsi, pane, 1.5);
      part.applyOptions({ priceFormat: { type: 'custom', formatter: (x) => x.toFixed(1), minMove: 0.1 }, lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      part.setData(points(v));
      for (const level of [70, 30]) part.createPriceLine({ price: level, color: css('--muted'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
      series.push({ key: 'rsi', label: 'RSI ' + ind.rsi.period, color: IND_COLORS.rsi, parts: [part], value: (i) => v[i] === null ? '—' : v[i].toFixed(2) });
      heights.push([pane, 0.28]); pane += 1;
    }
    if (ind.macd.on) {
      const v = macd(closes, ind.macd.fast, ind.macd.slow, ind.macd.signal);
      const hist = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-9 } }, pane);
      hist.setData(rows.map((row, i) => v[i] && v[i][2] !== null ? { time: row.time, value: v[i][2], color: (v[i][2] >= 0 ? css('--up') : css('--down')) + '99' } : { time: row.time }));
      const macdLine = line(IND_COLORS.macd, pane); macdLine.setData(points(v, (x) => x[0]));
      const signalLine = line(IND_COLORS.signal, pane); signalLine.setData(points(v, (x) => x[1]));
      series.push({ key: 'macd', label: 'MACD ' + ind.macd.fast + ' ' + ind.macd.slow + ' ' + ind.macd.signal, color: IND_COLORS.macd, parts: [hist, macdLine, signalLine], value: (i) => v[i] ? fmt(v[i][0]) + ' ' + fmt(v[i][1]) + ' ' + fmt(v[i][2]) : '—' });
      heights.push([pane, 0.28]); pane += 1;
    }
    // Panes share the height by proportion: the price pane 1, indicators a fraction of it.
    chart.panes()[0].setStretchFactor(1);
    for (const [p, factor] of heights) chart.panes()[p] && chart.panes()[p].setStretchFactor(factor);
    renderIndicatorMenu();
    legend();
  }

  function setTimeframe(size) {
    // Keep the same moment in view when switching.
    const range = chart.timeScale().getVisibleLogicalRange();
    const middle = range ? logicalToTime((range.from + range.to) / 2) : null;
    const width = range ? (range.to - range.from) * step : null;
    step = size; rows = resample(step); times = rows.map((row) => row.time); index = new Map(times.map((time, i) => [time, i]));
    chart.applyOptions({ timeScale: { timeVisible: step < 86400 } });
    buildMain(); buildIndicators();
    if (middle !== null && width) {
      // Same moment in the middle and about the same span, but never more bars than fit at 2px each,
      // or the chart would give up the position and jump to the latest bar.
      const bars = clamp(width / step, 20, Math.max(20, paneWidth() / 2));
      const center = timeToLogical(middle);
      chart.timeScale().setVisibleLogicalRange({ from: center - bars / 2, to: center + bars / 2 });
    }
    for (const button of $('timeframes').children) button.setAttribute('aria-pressed', String(Number(button.dataset.size) === size));
    renderDetails();
  }

  // ---------- Coordinates: drawings are stored as (time, price) ----------
  function timeToLogical(t) {
    const n = times.length;
    if (!n) return 0;
    if (t <= times[0]) return (t - times[0]) / step;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
    let lo = 0; let hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - times[lo]) / (times[hi] - times[lo]);
  }
  function logicalToTime(l) {
    const n = times.length;
    if (!n) return 0;
    if (l <= 0) return times[0] + l * step;
    if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * step;
    const i = Math.floor(l);
    return times[i] + (l - i) * (times[i + 1] - times[i]);
  }
  const X = (t) => chart.timeScale().logicalToCoordinate(timeToLogical(t));
  const Y = (p) => main.priceToCoordinate(p);
  const P = (y) => main.coordinateToPrice(y);
  const paneWidth = () => chart.timeScale().width();
  const paneHeight = () => chart.panes()[0].getHeight();

  /** The (time, price) under a point, anchored to the nearest bar; the magnet snaps the price to its open, high, low or close. */
  function pointAt(x, y, magnet = settings.magnet) {
    const logical = Math.round(chart.timeScale().coordinateToLogical(x));
    const t = logicalToTime(logical);
    let p = P(y);
    const row = ohlcRows()[logical];
    if (magnet && row) {
      let best = null;
      for (const value of [row.open, row.high, row.low, row.close]) { const d = Math.abs(Y(value) - y); if (best === null || d < best[0]) best = [d, value]; }
      p = best[1];
    }
    return { t, p };
  }

  // ---------- Drawings ----------
  const COLORS = ['#2962ff', '#089981', '#f23645', '#ff9800', '#9c27b0', '#787b86'];
  const TOOLS = {
    cursor: { label: 'Cross', key: 'Escape' },
    trend: { label: 'Trend line', key: 'Alt+T', points: 2 },
    ray: { label: 'Ray', key: 'Alt+R', points: 2 },
    hline: { label: 'Horizontal line', key: 'Alt+H', points: 1 },
    vline: { label: 'Vertical line', key: 'Alt+V', points: 1 },
    rect: { label: 'Rectangle', key: 'Alt+B', points: 2 },
    fib: { label: 'Fib retracement', key: 'Alt+F', points: 2 },
    measure: { label: 'Measure', key: 'Alt+M', points: 2 },
    long: { label: 'Long position', key: 'Alt+L', points: 1 },
    short: { label: 'Short position', key: 'Alt+S', points: 1 },
    text: { label: 'Text note', key: 'Alt+N', points: 1 },
  };
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86'];

  let drawings = load(DRAWINGS_KEY, []).filter((d) => d && TOOLS[d.type] && Array.isArray(d.points));
  let tool = 'cursor';
  let selectedId = null;
  let hoverId = null;
  let creating = null;
  let drag = null;
  let hideAll = false;
  let lockAll = false;
  const undoStack = [];
  const redoStack = [];
  const uid = () => Math.random().toString(36).slice(2, 10);

  function remember() { undoStack.push(JSON.stringify(drawings)); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  function persist() { save(DRAWINGS_KEY, drawings); renderFloatBar(); updateUndoButtons(); }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(drawings)); drawings = JSON.parse(undoStack.pop()); selectedId = null; persist(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(drawings)); drawings = JSON.parse(redoStack.pop()); selectedId = null; persist(); }
  const selected = () => drawings.find((d) => d.id === selectedId) || null;

  function setTool(name) {
    if (!TOOLS[name]) return;
    creating = null; tool = name;
    if (name !== 'cursor') selectedId = null;
    for (const button of document.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === name));
    $('chart-area').classList.toggle('drawing', name !== 'cursor');
    renderFloatBar();
  }

  /** A new drawing at a point; one-point tools are complete at once. */
  function newDrawing(type, at) {
    const drawing = { id: uid(), type, color: type === 'short' ? '#f23645' : type === 'long' ? '#089981' : COLORS[0], width: 2, points: [at, { ...at }] };
    if (type === 'hline' || type === 'vline' || type === 'text') drawing.points = [at];
    if (type === 'ray') drawing.extend = 'right';
    if (type === 'long' || type === 'short') {
      // Target and stop start 3% and 1.5% away; the right edge 20 bars on. All three are draggable.
      const dir = type === 'long' ? 1 : -1;
      const end = logicalToTime(timeToLogical(at.t) + 20);
      drawing.points = [at, { t: end, p: at.p * (1 + 0.03 * dir) }, { t: end, p: at.p * (1 - 0.015 * dir) }];
    }
    return drawing;
  }
  function finish(drawing) {
    remember(); drawings.push(drawing); selectedId = drawing.id; creating = null;
    if (!$('keep-drawing').classList.contains('active')) setTool('cursor');
    persist();
    if (drawing.type === 'text') editText(drawing);
  }

  // Pixel geometry for drawing and hit testing.
  function geometry(d) {
    const w = paneWidth(); const h = paneHeight();
    const pts = d.points.map((pt) => ({ x: X(pt.t), y: Y(pt.p) }));
    if (pts.some((pt) => pt.x === null || pt.y === null)) return null;
    const g = { pts, segments: [], areas: [], handles: pts };
    // Extended ends go far past the pane; the canvas clips them.
    const extendLine = (a, b, mode) => {
      const dx = b.x - a.x; const dy = b.y - a.y; const k = 20000 / (Math.hypot(dx, dy) || 1);
      return [mode === 'both' ? { x: a.x - dx * k, y: a.y - dy * k } : a, mode === 'right' || mode === 'both' ? { x: b.x + dx * k, y: b.y + dy * k } : b];
    };
    if (d.type === 'trend' || d.type === 'ray') g.segments.push(extendLine(pts[0], pts[1], d.extend || 'none'));
    else if (d.type === 'hline') { g.segments.push([{ x: 0, y: pts[0].y }, { x: w, y: pts[0].y }]); }
    else if (d.type === 'vline') { g.segments.push([{ x: pts[0].x, y: 0 }, { x: pts[0].x, y: h }]); }
    else if (d.type === 'rect' || d.type === 'measure') {
      const [a, b] = pts; g.areas.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
      if (d.type === 'rect') g.handles = [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }];
    } else if (d.type === 'fib') {
      const [a, b] = pts; const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
      g.levels = FIB.map((level) => { const price = d.points[1].p + (d.points[0].p - d.points[1].p) * level; return { level, price, y: Y(price) }; });
      for (const level of g.levels) g.segments.push([{ x: left, y: level.y }, { x: right, y: level.y }]);
      g.segments.push([a, b]);
      g.areas.push({ x: left, y: Math.min(a.y, b.y), w: right - left, h: Math.abs(b.y - a.y) });
    } else if (d.type === 'long' || d.type === 'short') {
      const [entry, target, stop] = pts; const right = target.x;
      g.areas.push({ x: Math.min(entry.x, right), y: Math.min(entry.y, target.y), w: Math.abs(right - entry.x), h: Math.abs(target.y - entry.y), kind: 'profit' });
      g.areas.push({ x: Math.min(entry.x, right), y: Math.min(entry.y, stop.y), w: Math.abs(right - entry.x), h: Math.abs(stop.y - entry.y), kind: 'loss' });
      g.handles = [entry, { x: entry.x, y: target.y }, { x: entry.x, y: stop.y }, { x: right, y: entry.y }];
    } else if (d.type === 'text') {
      const ctx = overlay.getContext('2d'); ctx.font = '600 13px ' + getComputedStyle(document.body).fontFamily;
      const width = ctx.measureText(d.text || 'Text').width + 12;
      g.areas.push({ x: pts[0].x, y: pts[0].y - 22, w: width, h: 22 });
    }
    return g;
  }

  const distanceToSegment = (p, [a, b]) => {
    const dx = b.x - a.x; const dy = b.y - a.y; const len = dx * dx + dy * dy;
    const k = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
  };
  /** The drawing (and handle) under a point, the selected one first. */
  function hitTest(x, y) {
    if (hideAll) return null;
    const ordered = [...drawings].reverse().sort((a, b) => (b.id === selectedId) - (a.id === selectedId));
    for (const d of ordered) {
      const g = geometry(d);
      if (!g) continue;
      if (d.id === selectedId) {
        const handle = g.handles.findIndex((pt) => Math.hypot(pt.x - x, pt.y - y) <= 7);
        if (handle >= 0) return { drawing: d, handle };
      }
      if (g.segments.some((segment) => distanceToSegment({ x, y }, segment) <= 6)) return { drawing: d, handle: -1 };
      if (g.areas.some((area) => x >= area.x - 3 && x <= area.x + area.w + 3 && y >= area.y - 3 && y <= area.y + area.h + 3)) return { drawing: d, handle: -1 };
    }
    return null;
  }

  // ---------- Rendering the drawing layer ----------
  const overlay = $('overlay');
  const tag = (ctx, text, x, y, color, align = 'left') => {
    ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
    const width = ctx.measureText(text).width + 10;
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    ctx.fillStyle = color; roundRect(ctx, left, y - 9, width, 18, 3); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(text, left + 5, y + 0.5);
    return width;
  };
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; };

  function drawOne(ctx, d, active) {
    const g = geometry(d);
    if (!g) return;
    const w = paneWidth();
    ctx.lineWidth = d.width + (active && d.id !== selectedId ? 0.5 : 0);
    ctx.strokeStyle = d.color; ctx.fillStyle = alpha(d.color, 0.12); ctx.setLineDash([]);
    if (d.type === 'rect') for (const a of g.areas) { ctx.fillRect(a.x, a.y, a.w, a.h); ctx.strokeRect(a.x, a.y, a.w, a.h); }
    if (d.type === 'fib') {
      g.levels.forEach((level, i) => {
        const next = g.levels[i + 1];
        if (next) { ctx.fillStyle = alpha(FIB_COLORS[i + 1], 0.08); ctx.fillRect(g.areas[0].x, Math.min(level.y, next.y), g.areas[0].w, Math.abs(next.y - level.y)); }
        ctx.strokeStyle = FIB_COLORS[i]; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(g.areas[0].x, level.y); ctx.lineTo(g.areas[0].x + g.areas[0].w, level.y); ctx.stroke();
        ctx.fillStyle = FIB_COLORS[i]; ctx.font = '11px ' + getComputedStyle(document.body).fontFamily; ctx.textBaseline = 'bottom';
        ctx.fillText(level.level + ' (' + fmt(level.price) + ')', g.areas[0].x + 4, level.y - 2);
      });
      ctx.strokeStyle = alpha(d.color, 0.6); ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(g.pts[0].x, g.pts[0].y); ctx.lineTo(g.pts[1].x, g.pts[1].y); ctx.stroke(); ctx.setLineDash([]);
    }
    if (d.type === 'measure') {
      const [a, b] = d.points; const rise = b.p >= a.p; const color = rise ? '#2962ff' : '#f23645';
      const area = g.areas[0];
      ctx.fillStyle = alpha(color, 0.15); ctx.fillRect(area.x, area.y, area.w, area.h);
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      const midX = area.x + area.w / 2; const midY = area.y + area.h / 2;
      ctx.beginPath(); ctx.moveTo(midX, g.pts[0].y); ctx.lineTo(midX, g.pts[1].y); ctx.moveTo(g.pts[0].x, midY); ctx.lineTo(g.pts[1].x, midY); ctx.stroke();
      const bars = Math.round(timeToLogical(b.t) - timeToLogical(a.t));
      const text = signed(b.p - a.p) + ' (' + pct((b.p / a.p - 1) * 100) + ') · ' + bars + ' bars, ' + span(b.t - a.t);
      tag(ctx, text, midX, (rise ? area.y - 14 : area.y + area.h + 14), color, 'center');
    }
    if (d.type === 'long' || d.type === 'short') {
      const [entry, target, stop] = d.points;
      const [profit, loss] = g.areas;
      ctx.fillStyle = alpha('#089981', 0.18); ctx.fillRect(profit.x, profit.y, profit.w, profit.h);
      ctx.fillStyle = alpha('#f23645', 0.18); ctx.fillRect(loss.x, loss.y, loss.w, loss.h);
      ctx.strokeStyle = css('--muted'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(profit.x, g.pts[0].y); ctx.lineTo(profit.x + profit.w, g.pts[0].y); ctx.stroke();
      const gain = Math.abs(target.p / entry.p - 1) * 100; const risk = Math.abs(stop.p / entry.p - 1) * 100;
      const left = profit.x + profit.w / 2;
      tag(ctx, 'Target ' + fmt(target.p) + ' (' + gain.toFixed(2) + '%)', left, Y(target.p) + (d.type === 'long' ? -12 : 12), '#089981', 'center');
      tag(ctx, 'Stop ' + fmt(stop.p) + ' (' + risk.toFixed(2) + '%)', left, Y(stop.p) + (d.type === 'long' ? 12 : -12), '#f23645', 'center');
      tag(ctx, (d.type === 'long' ? 'Long ' : 'Short ') + fmt(entry.p) + ' · R:R ' + (risk ? (gain / risk).toFixed(2) : '—'), left, g.pts[0].y, css('--muted'), 'center');
    }
    if (d.type === 'trend' || d.type === 'ray' || d.type === 'hline' || d.type === 'vline') {
      ctx.strokeStyle = d.color; ctx.beginPath();
      for (const [a, b] of g.segments) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
      if (d.type === 'hline') tag(ctx, fmt(d.points[0].p), w - 4, g.pts[0].y, d.color, 'right');
      if (d.type === 'vline') tag(ctx, when(d.points[0].t), g.pts[0].x, paneHeight() - 12, d.color, 'center');
    }
    if (d.type === 'text') {
      const area = g.areas[0];
      ctx.fillStyle = alpha(d.color, 0.9); roundRect(ctx, area.x, area.y, area.w, area.h, 4); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = '600 13px ' + getComputedStyle(document.body).fontFamily; ctx.textBaseline = 'middle';
      ctx.fillText(d.text || 'Text', area.x + 6, area.y + area.h / 2 + 0.5);
    }
    if (d.id === selectedId || (creating && creating.id === d.id)) {
      for (const pt of g.handles) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fillStyle = css('--bg'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = d.color; ctx.stroke(); }
      // Price tags on the right edge, like axis labels.
      if (d.type !== 'vline' && d.type !== 'hline') for (const pt of d.points) tag(ctx, fmt(pt.p), w - 4, Y(pt.p), d.color, 'right');
    }
  }

  let dirty = true;
  function frame() {
    const w = paneWidth(); const h = paneHeight(); const ratio = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(w * ratio) || overlay.height !== Math.round(h * ratio)) {
      overlay.width = Math.round(w * ratio); overlay.height = Math.round(h * ratio); overlay.style.width = w + 'px'; overlay.style.height = h + 'px'; dirty = true;
    }
    if (dirty && main) {
      dirty = false;
      const ctx = overlay.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
      if (!hideAll) for (const d of drawings) drawOne(ctx, d, d.id === hoverId);
      if (creating) drawOne(ctx, creating, true);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  const redraw = () => { dirty = true; };
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { redraw(); updateToLatest(); renderVisible(); });
  chart.subscribeCrosshairMove((param) => { redraw(); legend(param); });

  // ---------- Pointer interaction ----------
  const area = $('chart-area');
  const local = (event) => { const rect = area.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const inPane = ({ x, y }) => x >= 0 && y >= 0 && x <= paneWidth() && y <= paneHeight();
  let swallow = false;
  // Controls floating over the chart handle their own clicks.
  const onControl = (event) => Boolean(event.target.closest && event.target.closest('.float-bar, .to-latest, .text-input, #legend .ind'));
  const freezeChart = (frozen) => chart.applyOptions({ handleScroll: !frozen, handleScale: !frozen });

  area.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || onControl(event)) return;
    const at = local(event);
    if (!inPane(at)) return;
    if (tool !== 'cursor') {
      const point = pointAt(at.x, at.y);
      if (creating) { creating.points[1] = point; finish(creating); }
      else if (TOOLS[tool].points === 1) finish(newDrawing(tool, point));
      else { creating = newDrawing(tool, point); creating.down = at; freezeChart(true); }
      swallow = true; event.stopPropagation(); event.preventDefault(); redraw();
      return;
    }
    const hit = hitTest(at.x, at.y);
    if (!hit) { if (selectedId) { selectedId = null; renderFloatBar(); redraw(); } return; }
    selectedId = hit.drawing.id; renderFloatBar();
    if (!(hit.drawing.locked || lockAll)) {
      const logical = chart.timeScale().coordinateToLogical(at.x);
      drag = { id: hit.drawing.id, handle: hit.handle, logical, price: P(at.y), before: JSON.stringify(drawings), original: JSON.parse(JSON.stringify(hit.drawing.points)), moved: false };
      area.classList.add('dragging'); freezeChart(true);
      try { area.setPointerCapture(event.pointerId); } catch (e) { /* Synthetic events. */ }
    }
    swallow = true; event.stopPropagation(); event.preventDefault(); redraw();
  }, true);

  area.addEventListener('pointermove', (event) => {
    if (!drag && !creating && onControl(event)) return;
    const at = local(event);
    if (creating) {
      creating.points[1] = pointAt(at.x, at.y);
      if (creating.down && Math.hypot(at.x - creating.down.x, at.y - creating.down.y) > 5) creating.dragged = true;
      redraw(); return;
    }
    if (drag) {
      const d = drawings.find((item) => item.id === drag.id);
      if (!d) return;
      drag.moved = true;
      if (drag.handle >= 0) {
        const point = pointAt(at.x, at.y);
        if (d.type === 'rect' && drag.handle >= 2) {
          // Corner handles mix the two points' times and prices.
          if (drag.handle === 2) { d.points[0].t = point.t; d.points[1].p = point.p; } else { d.points[1].t = point.t; d.points[0].p = point.p; }
        } else if (d.type === 'long' || d.type === 'short') {
          if (drag.handle === 0) d.points[0] = point;
          else if (drag.handle === 1) d.points[1].p = point.p;
          else if (drag.handle === 2) d.points[2].p = point.p;
          else { d.points[1].t = point.t; d.points[2].t = point.t; }
        } else d.points[drag.handle] = point;
      } else {
        // Move the whole drawing by whole bars and by price.
        const dl = Math.round(chart.timeScale().coordinateToLogical(at.x) - drag.logical);
        const dp = P(at.y) - drag.price;
        d.points = drag.original.map((pt) => ({ t: logicalToTime(timeToLogical(pt.t) + dl), p: pt.p + dp }));
      }
      redraw(); return;
    }
    if (tool !== 'cursor' || !inPane(at)) { if (hoverId) { hoverId = null; area.classList.remove('hover-drawing'); redraw(); } return; }
    const hit = hitTest(at.x, at.y);
    const id = hit ? hit.drawing.id : null;
    area.classList.toggle('hover-drawing', Boolean(hit));
    area.classList.toggle('hover-handle', Boolean(hit && hit.handle >= 0));
    if (id !== hoverId) { hoverId = id; redraw(); }
  }, true);

  const release = (event) => {
    if (creating && creating.dragged && event && event.type === 'pointerup') { finish(creating); freezeChart(false); }
    else if (creating) { /* Click-click: wait for the second click. */ }
    if (drag) {
      if (drag.moved) { undoStack.push(drag.before); redoStack.length = 0; persist(); }
      drag = null; area.classList.remove('dragging'); freezeChart(false);
    }
    if (!creating) freezeChart(false);
    redraw();
  };
  area.addEventListener('pointerup', release, true);
  area.addEventListener('pointercancel', release, true);
  // The chart library listens to mouse and touch events too; keep them from panning while a drawing is handled.
  for (const type of ['mousedown', 'mousemove', 'touchstart', 'touchmove']) {
    area.addEventListener(type, (event) => { if (swallow || drag || creating) event.stopPropagation(); }, { capture: true, passive: true });
  }
  for (const type of ['mouseup', 'touchend']) area.addEventListener(type, () => { swallow = false; }, true);
  area.addEventListener('dblclick', (event) => {
    const at = local(event); const hit = hitTest(at.x, at.y);
    if (hit && hit.drawing.type === 'text') { event.stopPropagation(); editText(hit.drawing); }
  }, true);
  area.addEventListener('contextmenu', (event) => {
    const at = local(event); const hit = inPane(at) ? hitTest(at.x, at.y) : null;
    if (hit) { event.preventDefault(); selectedId = hit.drawing.id; renderFloatBar(); redraw(); }
  });

  function editText(d) {
    const input = $('text-input'); const g = geometry(d);
    if (!g) return;
    input.style.left = g.pts[0].x + 'px'; input.style.top = (g.pts[0].y - 26) + 'px'; input.style.display = 'block';
    input.value = d.text || ''; input.focus(); input.select();
    const done = (keep) => {
      input.style.display = 'none'; input.onkeydown = null; input.onblur = null;
      if (keep) { remember(); d.text = input.value.trim() || 'Text'; persist(); }
      redraw();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); };
    input.onblur = () => done(true);
  }

  // ---------- Floating style bar for the selected drawing ----------
  function renderFloatBar() {
    const bar = $('float-bar'); const d = selected();
    bar.classList.toggle('open', Boolean(d));
    if (!d) { redraw(); return; }
    const parts = COLORS.map((color) => '<button class="dot" type="button" title="Color" data-color="' + color + '" aria-pressed="' + (d.color === color) + '" style="background:' + color + '"></button>');
    parts.push('<span class="sep"></span>');
    for (const width of [1, 2, 3]) parts.push('<button class="btn icon" type="button" title="Line width ' + width + '" data-width="' + width + '" aria-pressed="' + (d.width === width) + '"><svg viewBox="0 0 24 24"><path d="M4 12h16" stroke-width="' + width * 1.2 + '"/></svg></button>');
    if (d.type === 'trend' || d.type === 'ray') parts.push('<button class="btn" type="button" data-extend title="Extend the line">Extend: ' + (d.extend || 'none') + '</button>');
    parts.push('<span class="sep"></span>');
    parts.push('<button class="btn icon" type="button" data-lock title="' + (d.locked ? 'Unlock' : 'Lock') + '" aria-pressed="' + Boolean(d.locked) + '">' + ICONS.lock + '</button>');
    parts.push('<button class="btn icon" type="button" data-clone title="Clone">' + ICONS.clone + '</button>');
    parts.push('<button class="btn icon" type="button" data-delete title="Delete (Del)">' + ICONS.trash + '</button>');
    bar.innerHTML = parts.join('');
    redraw();
  }
  $('float-bar').addEventListener('click', (event) => {
    const button = event.target.closest('button'); const d = selected();
    if (!button || !d) return;
    remember();
    if (button.dataset.color) d.color = button.dataset.color;
    else if (button.dataset.width) d.width = Number(button.dataset.width);
    else if (button.hasAttribute('data-extend')) d.extend = { none: 'right', right: 'both', both: 'none' }[d.extend || 'none'];
    else if (button.hasAttribute('data-lock')) d.locked = !d.locked;
    else if (button.hasAttribute('data-clone')) { const copy = JSON.parse(JSON.stringify(d)); copy.id = uid(); copy.locked = false; copy.points = copy.points.map((pt) => ({ t: logicalToTime(timeToLogical(pt.t) + 5), p: pt.p })); drawings.push(copy); selectedId = copy.id; }
    else if (button.hasAttribute('data-delete')) { drawings = drawings.filter((item) => item.id !== d.id); selectedId = null; }
    persist();
  });

  // ---------- Legend: values under the crosshair ----------
  function legend(param) {
    const i = param && param.time !== undefined && index.has(param.time) ? index.get(param.time) : rows.length - 1;
    const row = rows[i];
    const tf = (timeframes.find(([, size]) => size === step) || [String(step / 60) + 'm'])[0];
    let html = '<div class="line"><span class="title">' + escapeHtml(DATA.pair) + '</span><span class="k">' + escapeHtml(tf + ' · ' + DATA.pool + ' · ' + DATA.chain) + '</span></div>';
    if (row) {
      const shown = settings.type === 'heikin' ? heikinAshi(rows)[i] : row;
      const change = shown.close - shown.open; const cls = change >= 0 ? 'up' : 'down';
      html += '<div class="line"><span><span class="k">O</span> <span class="' + cls + '">' + fmt(shown.open) + '</span></span><span><span class="k">H</span> <span class="' + cls + '">' + fmt(shown.high) + '</span></span><span><span class="k">L</span> <span class="' + cls + '">' + fmt(shown.low) + '</span></span><span><span class="k">C</span> <span class="' + cls + '">' + fmt(shown.close) + '</span></span><span class="' + cls + '">' + signed(change) + ' (' + pct((shown.close / shown.open - 1) * 100) + ')</span>'
        + (row.filled ? '<span class="k">no trades</span>' : '') + '<span class="k">' + when(row.time) + ' UTC</span></div>';
      for (const item of series) {
        html += '<div class="line"><span class="ind" data-key="' + item.key + '"><span class="swatch" style="background:' + item.color + '"></span><span class="k">' + escapeHtml(item.label) + '</span> <span>' + item.value(i) + '</span>'
          + '<button type="button" data-settings title="Settings">⚙</button><button type="button" data-remove title="Remove">✕</button></span></div>';
      }
    }
    $('legend').innerHTML = html;
  }
  $('legend').addEventListener('click', (event) => {
    const button = event.target.closest('button'); const item = event.target.closest('.ind');
    if (!button || !item) return;
    if (button.hasAttribute('data-remove')) { settings.ind[item.dataset.key].on = false; saveSettings(); buildIndicators(); }
    else openMenu('indicators-menu', $('indicators-button'));
  });

  // ---------- Menus ----------
  function openMenu(id, anchor) {
    const menu = $(id); const open = !menu.classList.contains('open');
    closeMenus();
    if (!open) return;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px'; menu.style.top = rect.bottom + 4 + 'px';
    menu.classList.add('open');
  }
  const closeMenus = () => { for (const menu of document.querySelectorAll('.menu.open')) menu.classList.remove('open'); };
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.menu') && !event.target.closest('[data-menu]')) closeMenus(); });

  const TYPES = [['candles', 'Candles'], ['hollow', 'Hollow candles'], ['heikin', 'Heikin Ashi'], ['bars', 'Bars'], ['line', 'Line'], ['area', 'Area']];
  function renderTypeMenu() {
    $('type-menu').innerHTML = TYPES.map(([key, label]) => '<button class="item" type="button" role="menuitemradio" data-type="' + key + '" aria-checked="' + (settings.type === key) + '">' + ICONS[key] + label + '</button>').join('');
    $('type-button').innerHTML = ICONS[settings.type] + '<span>' + TYPES.find(([key]) => key === settings.type)[1] + '</span>' + ICONS.caret;
  }
  $('type-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-type]'); if (!item) return;
    settings.type = item.dataset.type; saveSettings(); buildMain(); renderTypeMenu(); closeMenus(); legend();
  });

  const IND_FIELDS = {
    volume: ['Volume', []], ma: ['Moving average (MA)', [['period', 'Length']]], ema: ['Exponential MA (EMA)', [['period', 'Length']]],
    bb: ['Bollinger Bands', [['period', 'Length'], ['mult', 'StdDev']]], vwap: ['VWAP (daily)', []], rsi: ['Relative Strength Index', [['period', 'Length']]],
    macd: ['MACD', [['fast', 'Fast'], ['slow', 'Slow'], ['signal', 'Signal']]],
  };
  function renderIndicatorMenu() {
    $('indicators-menu').innerHTML = '<h4>Indicators</h4>' + Object.entries(IND_FIELDS).map(([key, [label, fields]]) => {
      const value = settings.ind[key];
      return '<div class="row"><label><input type="checkbox" data-ind="' + key + '"' + (value.on ? ' checked' : '') + '><span class="swatch" style="background:' + (IND_COLORS[key] || css('--muted')) + '"></span>' + label + '</label>'
        + fields.map(([field, title]) => '<input type="number" min="1" max="500" step="' + (field === 'mult' ? '0.5' : '1') + '" title="' + title + '" data-ind="' + key + '" data-field="' + field + '" value="' + value[field] + '">').join('') + '</div>';
    }).join('');
  }
  $('indicators-menu').addEventListener('change', (event) => {
    const input = event.target; const key = input.dataset.ind; if (!key) return;
    if (input.type === 'checkbox') settings.ind[key].on = input.checked;
    else { const value = Number(input.value); if (value > 0) { settings.ind[key][input.dataset.field] = value; settings.ind[key].on = true; } }
    saveSettings(); buildIndicators();
  });

  // ---------- Toolbars ----------
  const ICONS = {
    cursor: '<svg viewBox="0 0 24 24"><path d="M12 3v7M12 14v7M3 12h7M14 12h7"/></svg>',
    trend: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/></svg>',
    ray: '<svg viewBox="0 0 24 24"><path d="M5 19L21 3"/><circle cx="5" cy="19" r="1.8"/><circle cx="12" cy="12" r="1.8"/></svg>',
    hline: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><circle cx="12" cy="12" r="1.8"/></svg>',
    vline: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><circle cx="12" cy="12" r="1.8"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
    fib: '<svg viewBox="0 0 24 24"><path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/></svg>',
    measure: '<svg viewBox="0 0 24 24"><path d="M4 20V8M4 20h12M8 16l10-10M14 6h4v4"/></svg>',
    long: '<svg viewBox="0 0 24 24"><path d="M4 18h16M7 14l4-4 3 3 5-6"/><path d="M15 7h4v4"/></svg>',
    short: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 10l4 4 3-3 5 6"/><path d="M15 17h4v-4"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
    magnet: '<svg viewBox="0 0 24 24"><path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/></svg>',
    keep: '<svg viewBox="0 0 24 24"><path d="M14 4l6 6-3 1-4 4 1 4-2 1-4-4-4 4M10 14l-1-4 4-4 1-3"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    clone: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V4h12"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    theme: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
    indicators: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 4-7 5 5"/></svg>',
    latest: '<svg viewBox="0 0 24 24"><path d="M6 6l6 6-6 6M13 6l6 6-6 6"/></svg>',
    caret: '<svg class="caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    candles: '<svg viewBox="0 0 24 24"><path d="M8 3v4M8 15v6M16 3v6M16 17v4"/><rect x="5.5" y="7" width="5" height="8" fill="currentColor"/><rect x="13.5" y="9" width="5" height="8"/></svg>',
    hollow: '<svg viewBox="0 0 24 24"><path d="M8 3v4M8 15v6M16 3v6M16 17v4"/><rect x="5.5" y="7" width="5" height="8"/><rect x="13.5" y="9" width="5" height="8"/></svg>',
    heikin: '<svg viewBox="0 0 24 24"><path d="M8 4v16M16 4v16"/><rect x="5.5" y="8" width="5" height="7" fill="currentColor"/><rect x="13.5" y="6" width="5" height="7" fill="currentColor"/></svg>',
    bars: '<svg viewBox="0 0 24 24"><path d="M8 4v16M5 8h3M8 16h3M16 4v16M13 13h3M16 7h3"/></svg>',
    line: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 4-7 5 5"/></svg>',
    area: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 4-7 5 5v8H3z"/></svg>',
  };

  $('tools').innerHTML = Object.entries(TOOLS).map(([key, info], i) => (i === 1 ? '<span class="sep"></span>' : '') + '<button class="btn icon" type="button" data-tool="' + key + '" title="' + info.label + ' (' + info.key + ')" aria-label="' + info.label + '" aria-pressed="' + (key === 'cursor') + '">' + ICONS[key] + '</button>').join('')
    + '<span class="sep"></span>'
    + '<button class="btn icon" type="button" id="magnet" title="Magnet: snap to open, high, low, close (Alt+G)" aria-pressed="' + settings.magnet + '">' + ICONS.magnet + '</button>'
    + '<button class="btn icon" type="button" id="keep-drawing" title="Stay in drawing mode">' + ICONS.keep + '</button>'
    + '<button class="btn icon" type="button" id="lock-all" title="Lock all drawings" aria-pressed="false">' + ICONS.lock + '</button>'
    + '<button class="btn icon" type="button" id="hide-all" title="Hide all drawings" aria-pressed="false">' + ICONS.eye + '</button>'
    + '<button class="btn icon" type="button" id="clear-all" title="Remove all drawings">' + ICONS.trash + '</button>';
  $('tools').addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.tool) setTool(button.dataset.tool);
    else if (button.id === 'magnet') { settings.magnet = !settings.magnet; button.setAttribute('aria-pressed', String(settings.magnet)); saveSettings(); toast('Magnet ' + (settings.magnet ? 'on' : 'off')); }
    else if (button.id === 'keep-drawing') { button.classList.toggle('active'); toast(button.classList.contains('active') ? 'Drawing tools stay active' : 'Drawing tools return to the cursor'); }
    else if (button.id === 'lock-all') { lockAll = !lockAll; button.setAttribute('aria-pressed', String(lockAll)); toast(lockAll ? 'Drawings locked' : 'Drawings unlocked'); }
    else if (button.id === 'hide-all') { hideAll = !hideAll; button.setAttribute('aria-pressed', String(hideAll)); selectedId = null; renderFloatBar(); }
    else if (button.id === 'clear-all' && drawings.length) { remember(); drawings = []; selectedId = null; persist(); toast('All drawings removed · Ctrl+Z to undo'); }
  });

  $('timeframes').innerHTML = timeframes.map(([label, size]) => '<button class="btn" type="button" data-size="' + size + '" aria-pressed="' + (size === step) + '">' + label + '</button>').join('');
  $('timeframes').addEventListener('click', (event) => { const button = event.target.closest('[data-size]'); if (button) setTimeframe(Number(button.dataset.size)); });
  $('type-button').addEventListener('click', (event) => openMenu('type-menu', event.currentTarget));
  $('indicators-button').innerHTML = ICONS.indicators + '<span>Indicators</span>';
  $('indicators-button').addEventListener('click', (event) => openMenu('indicators-menu', event.currentTarget));
  $('undo').innerHTML = ICONS.undo; $('redo').innerHTML = ICONS.redo;
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  const updateUndoButtons = () => { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; };
  $('screenshot').innerHTML = ICONS.camera; $('fullscreen').innerHTML = ICONS.full; $('theme').innerHTML = ICONS.theme; $('panel').innerHTML = ICONS.panel;
  $('to-latest').innerHTML = ICONS.latest;
  $('to-latest').addEventListener('click', () => chart.timeScale().scrollToRealTime());
  const updateToLatest = () => { const range = chart.timeScale().getVisibleLogicalRange(); $('to-latest').classList.toggle('show', Boolean(range && range.to < rows.length - 3)); };

  $('screenshot').addEventListener('click', () => {
    const shot = chart.takeScreenshot();
    const out = document.createElement('canvas'); out.width = shot.width; out.height = shot.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = css('--bg'); ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(shot, 0, 0); ctx.drawImage(overlay, 0, 0);
    const ratio = window.devicePixelRatio || 1;
    ctx.fillStyle = css('--text'); ctx.font = (600 * 1) + ' ' + 14 * ratio + 'px ' + getComputedStyle(document.body).fontFamily; ctx.textBaseline = 'top';
    ctx.fillText(DATA.pair + ' · ' + DATA.pool + ' · ' + DATA.chain, 10 * ratio, 8 * ratio);
    const link = document.createElement('a');
    link.download = DATA.pair.replace('/', '-') + '_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.png';
    link.href = out.toDataURL('image/png'); link.click();
    toast('Screenshot saved');
  });
  $('fullscreen').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); });
  const applyTheme = () => {
    chart.applyOptions({
      layout: { textColor: css('--muted'), panes: { separatorColor: css('--line') } }, grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
      rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line') },
    });
    buildMain(); buildIndicators(); redraw();
  };
  $('theme').addEventListener('click', () => {
    const chosen = document.documentElement.getAttribute('data-theme');
    const dark = chosen ? chosen === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    settings.theme = dark ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', settings.theme); saveSettings(); applyTheme();
  });
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  $('panel').addEventListener('click', () => {
    if (narrow()) $('app').classList.toggle('side-open');
    else { settings.side = !settings.side; $('app').classList.toggle('side-hidden', !settings.side); saveSettings(); }
  });
  $('app').classList.toggle('side-hidden', !settings.side);

  // Bottom bar: visible range presets and price scale modes.
  const RANGES = [['1D', 86400], ['5D', 5 * 86400], ['1M', 30 * 86400], ['3M', 90 * 86400], ['6M', 182 * 86400], ['All', 0]];
  $('ranges').innerHTML = RANGES.map(([label, seconds]) => '<button class="btn" type="button" data-range="' + seconds + '">' + label + '</button>').join('');
  $('ranges').addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]'); if (!button || !rows.length) return;
    const seconds = Number(button.dataset.range);
    if (!seconds) { chart.timeScale().fitContent(); return; }
    const last = rows.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(-5, timeToLogical(rows[last].time - seconds)), to: last + 5 });
  });
  for (const button of document.querySelectorAll('[data-scale]')) button.addEventListener('click', () => { settings.scale = settings.scale === button.dataset.scale ? 'normal' : button.dataset.scale; saveSettings(); applyScale(); });
  $('auto-scale').addEventListener('click', () => { chart.priceScale('right').applyOptions({ autoScale: true }); toast('Price scale fits the data again'); });
  setInterval(() => { $('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);

  // ---------- Keyboard ----------
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); return; }
    if (event.key === 'Escape') { closeMenus(); if (creating) { creating = null; freezeChart(false); } selectedId = null; setTool('cursor'); redraw(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected()) { remember(); drawings = drawings.filter((d) => d.id !== selectedId); selectedId = null; persist(); return; }
    if (event.altKey) {
      const shortcuts = { t: 'trend', r: 'ray', h: 'hline', v: 'vline', b: 'rect', f: 'fib', m: 'measure', l: 'long', s: 'short', n: 'text' };
      if (shortcuts[event.code.replace('Key', '').toLowerCase()]) { event.preventDefault(); setTool(shortcuts[event.code.replace('Key', '').toLowerCase()]); }
      if (event.code === 'KeyG') { event.preventDefault(); $('magnet').click(); }
    }
  });

  let toastTimer;
  function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1600); }

  // ---------- Details panel ----------
  function renderDetails() {
    const t = DATA.ticker;
    let html = '<section><h3>Live</h3>';
    if (t) {
      const cls = t.change24hPct >= 0 ? 'up' : 'down';
      html += '<div class="big">' + fmt(t.price) + '</div><div class="' + cls + '">' + pct(t.change24hPct) + ' <span class="note">24h</span></div>';
      if (t.low24h !== undefined && t.high24h !== undefined && t.high24h > t.low24h) {
        html += '<div class="range-bar"><i style="left:' + clamp((t.price - t.low24h) / (t.high24h - t.low24h) * 100, 0, 100) + '%"></i></div><div class="kv"><dt>' + fmt(t.low24h) + '</dt><dd>' + fmt(t.high24h) + '</dd></div>';
      }
      html += '<dl class="kv"><dt>24h volume</dt><dd>' + usd(t.volume24hUsd) + '</dd><dt>Liquidity</dt><dd>' + usd(t.liquidityUsd) + '</dd>'
        + (t.trades24h !== undefined ? '<dt>24h trades</dt><dd>' + t.trades24h.toLocaleString('en-US') + '</dd>' : '') + '<dt>As of</dt><dd>' + new Date(t.updatedAt).toLocaleTimeString() + '</dd></dl>';
    } else html += '<div class="note">Live price unavailable' + (DATA.tickerNote ? ': ' + escapeHtml(DATA.tickerNote) : '') + '.</div>';
    html += '</section><section><h3>Visible range</h3><dl class="kv" id="visible-stats"></dl></section><section><h3>All loaded data</h3>' + statsList(rows) + '</section>';
    html += '<section><h3>Pool</h3><dl class="kv"><dt>Pair</dt><dd>' + escapeHtml(DATA.pair) + '</dd><dt>Pool</dt><dd>' + escapeHtml(DATA.pool) + '</dd><dt>Network</dt><dd>' + escapeHtml(DATA.chain) + '</dd><dt>Address</dt><dd><button class="btn" type="button" id="copy-address" title="Copy the address">'
      + escapeHtml(DATA.address.slice(0, 6) + '…' + DATA.address.slice(-4)) + '</button></dd><dt>Prices in</dt><dd>' + escapeHtml(DATA.priceUnit) + '</dd></dl></section>';
    const notes = [];
    if (DATA.sources.cached) notes.push(DATA.sources.cached + ' cached file' + (DATA.sources.cached === 1 ? '' : 's'));
    if (DATA.sources.downloaded) notes.push(DATA.sources.downloaded + ' new download' + (DATA.sources.downloaded === 1 ? '' : 's'));
    for (const [from, to] of DATA.sources.unavailable) notes.push('no data ' + when(from) + ' – ' + when(to));
    html += '<section><h3>Data</h3><div class="note">GeckoTerminal' + (notes.length ? ' · ' + escapeHtml(notes.join(' · ')) : '') + '. Times in UTC; grey candles had no trades. Made by defi-tool ' + when(Date.parse(DATA.generatedAt) / 1000)
      + ' UTC. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts.</div></section>';
    html += '<section><h3>Shortcuts</h3><div class="shortcuts">' + [['Alt+T / R / H / V', 'Trend, ray, horizontal, vertical'], ['Alt+B / F / M', 'Rectangle, Fibonacci, measure'], ['Alt+L / S / N', 'Long, short, text'], ['Alt+G', 'Magnet'], ['Drag', 'Move a drawing or its points'], ['Del', 'Delete the selected drawing'], ['Ctrl+Z / Ctrl+Y', 'Undo, redo'], ['Esc', 'Back to the cursor'], ['Wheel / drag axis', 'Zoom, scale prices']].map(([k, v]) => '<kbd>' + k + '</kbd><span>' + v + '</span>').join('') + '</div></section>';
    $('side').innerHTML = html;
    $('copy-address').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(DATA.address).then(() => toast('Address copied'), () => toast(DATA.address)); });
    renderVisible();
  }
  function statsList(list) {
    if (!list.length) return '<div class="note">No candles.</div>';
    const high = list.reduce((a, b) => b.high > a.high ? b : a); const low = list.reduce((a, b) => b.low < a.low ? b : a);
    const change = (list[list.length - 1].close / list[0].open - 1) * 100;
    const returns = list.slice(1).map((row, i) => Math.log(row.close / list[i].close)).filter(isFinite);
    const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const vol = returns.length > 1 ? Math.sqrt(variance * 365 * 86400 / step) * 100 : undefined;
    return '<dl class="kv"><dt>Change</dt><dd class="' + (change >= 0 ? 'up' : 'down') + '">' + pct(change) + '</dd><dt>High</dt><dd>' + fmt(high.high) + '</dd><dt></dt><dd class="note">' + when(high.time) + '</dd><dt>Low</dt><dd>' + fmt(low.low)
      + '</dd><dt></dt><dd class="note">' + when(low.time) + '</dd><dt>Volume</dt><dd>' + volume(list.reduce((a, b) => a + b.volume, 0)) + '</dd><dt>Volatility</dt><dd>' + (vol === undefined ? '—' : vol.toFixed(0) + '% / yr') + '</dd><dt>Candles</dt><dd>' + list.length.toLocaleString('en-US') + '</dd><dt>From</dt><dd class="note">' + when(list[0].time) + '</dd><dt>To</dt><dd class="note">' + when(list[list.length - 1].time + step) + '</dd></dl>';
  }
  let visibleTimer;
  function renderVisible() {
    clearTimeout(visibleTimer);
    visibleTimer = setTimeout(() => {
      const box = $('visible-stats'); const range = chart.timeScale().getVisibleLogicalRange();
      if (!box || !range) return;
      const list = rows.slice(Math.max(0, Math.ceil(range.from)), Math.min(rows.length, Math.floor(range.to) + 1));
      box.outerHTML = statsList(list).replace('<dl class="kv">', '<dl class="kv" id="visible-stats">');
    }, 120);
  }

  // ---------- Live header ----------
  if (DATA.ticker) {
    const cls = DATA.ticker.change24hPct >= 0 ? 'up' : 'down';
    $('live').innerHTML = '<span class="price">' + fmt(DATA.ticker.price) + '</span><span class="' + cls + '">' + pct(DATA.ticker.change24hPct) + '</span><span class="k" style="color:var(--muted)">' + escapeHtml(DATA.priceUnit) + '</span>';
  } else $('live').innerHTML = '<span style="color:var(--muted)">Live price unavailable</span>';
  $('symbol').innerHTML = '<b>' + escapeHtml(DATA.pair) + '</b><span>' + escapeHtml(DATA.pool + ' · ' + DATA.chain) + '</span>';

  // ---------- Start ----------
  renderTypeMenu();
  buildMain();
  buildIndicators();
  renderDetails();
  updateUndoButtons();
  if (rows.length) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-5, rows.length - 160), to: rows.length + 8 });
  else $('legend').innerHTML = '<div class="line"><span class="title">No candles in this range.</span></div>';
  new ResizeObserver(redraw).observe(area);
  requestAnimationFrame(frame);

  // A small API for scripts and tests: the page's state and the screen position of a (time, price).
  window.chartApp = {
    get drawings() { return JSON.parse(JSON.stringify(drawings)); },
    get selectedId() { return selectedId; }, get tool() { return tool; }, get step() { return step; }, get rows() { return rows.length; },
    get series() { return series.map((item) => item.key); }, get type() { return settings.type; },
    setTool, setTimeframe, undo, redo,
    toScreen: (t, p) => { const rect = area.getBoundingClientRect(); return { x: rect.left + X(t), y: rect.top + Y(p) }; },
    lastCandle: () => rows[rows.length - 1],
    timeframes: timeframes.map(([label, size]) => ({ label, size })),
    /** What the main series and each indicator series plot right now. */
    mainData: () => main.data().map((item) => ({ ...item })),
    seriesData: () => Object.fromEntries(series.map((item) => [item.key, item.parts.map((part) => part.data().length)])),
    visible: () => chart.timeScale().getVisibleLogicalRange(),
  };
})();

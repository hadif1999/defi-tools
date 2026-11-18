// positions detail --output html: builds the report from the embedded data. Plain DOM and SVG, plus TradingView's
// Lightweight Charts for the price chart. Exposes window.positionReport for tests.
(function () {
  'use strict';
  // The saved theme first: chart colors are read from the CSS tokens as the page is built.
  try { const saved = localStorage.getItem('position-report-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch (e) { /* storage blocked */ }
  const DATA = JSON.parse(document.getElementById('report-data').textContent);
  const D = DATA.detail;
  const P = D.prices;
  const perf = D.performance;
  const page = document.getElementById('page');
  const tip = document.getElementById('tip');
  const BASE = D.base.symbol;
  const QUOTE = D.quote.symbol;
  const NS = 'http://www.w3.org/2000/svg';
  const MISSING = '—';

  // ---------- formatting ----------
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  function num(v) {
    if (!finite(v)) return MISSING;
    if (v === 0) return '0';
    const a = Math.abs(v);
    const o = a >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : a >= 1 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumSignificantDigits: 4, maximumSignificantDigits: 4 };
    return new Intl.NumberFormat('en-US', o).format(v);
  }
  function usd(v) {
    if (!finite(v)) return MISSING;
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (a < 1000) return `${sign}$${a.toFixed(2)}`;
    for (const [size, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a / size >= 1) return `${sign}$${(a / size).toFixed(a / size >= 100 ? 0 : 1)}${s}`;
    return `${sign}$${a.toFixed(2)}`;
  }
  const signedUsd = (v) => !finite(v) ? MISSING : Math.abs(v) < 0.005 ? '$0.00' : `${v > 0 ? '+' : ''}${usd(v)}`;
  const pct = (v, d = 2) => !finite(v) ? MISSING : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
  const plainPct = (v, d = 1) => !finite(v) ? MISSING : `${v.toFixed(d)}%`;
  const when = (s) => s === undefined || s === null ? MISSING : new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const whenIso = (t) => t ? when(Date.parse(t) / 1000) : MISSING;
  const span = (days) => !finite(days) ? MISSING : days < 1 ? `${(days * 24).toFixed(1)} hours` : days < 100 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`;
  const tone = (v) => !finite(v) || Math.abs(v) < 0.005 ? '' : v > 0 ? 'pos' : 'neg';
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function el(tag, attrs, html) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    if (html !== undefined) node.innerHTML = html;
    return node;
  }
  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) node.setAttribute(k, v);
    return node;
  }
  const now = D.active ? (finite(P.live) ? P.live : P.current) : undefined;
  const exitOrNow = D.active ? now : P.exit;

  // ---------- tooltip ----------
  function showTip(event, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + w > innerWidth - 8) x = event.clientX - w - 14;
    if (y + h > innerHeight - 8) y = event.clientY - h - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.style.display = 'none'; };
  const tipRows = (title, rows) => `${title ? `<h4>${esc(title)}</h4>` : ''}${rows.filter(Boolean).map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b class="num">${v}</b></div>`).join('')}`;

  // ---------- header ----------
  const statusClass = D.status === 'closed' ? 'closed' : D.status === 'in' ? 'in' : 'out';
  const statusText = { in: '● In range', below: '▼ Below range', above: '▲ Above range', closed: '■ Closed' }[D.status];
  const fee = D.feeTier === undefined || D.feeTier === null ? '' : ` ${D.feeTier / 10000}%`;
  const head = el('header', { class: 'head' });
  const wallet = D.walletName || `${D.wallet.slice(0, 6)}…${D.wallet.slice(-4)}`;
  head.innerHTML = `<h1>${esc(D.pair + fee)}</h1>
    <span class="pill ${statusClass}" id="status">${statusText}${D.status === 'below' || D.status === 'above' ? ` ${Math.abs(P.outsidePct || 0).toFixed(1)}%` : ''}</span>
    <div class="chips"><span class="chip">${esc(D.dex)} ${esc(D.protocol)}</span><span class="chip">${esc(D.chain)}</span><span class="chip">#${esc(D.id)}</span>
    <span class="chip" title="${esc(D.wallet)}">${esc(wallet)}</span><span class="chip">${esc(D.unit)}</span></div>
    <span class="grow"></span>
    <div class="actions">
      ${D.links.position ? `<a class="btn" href="${esc(D.links.position)}" target="_blank" rel="noopener">Uniswap ↗</a>` : ''}
      ${D.links.pool ? `<a class="btn" href="${esc(D.links.pool)}" target="_blank" rel="noopener">Pool ↗</a>` : ''}
      ${D.links.wallet ? `<a class="btn" href="${esc(D.links.wallet)}" target="_blank" rel="noopener">Wallet ↗</a>` : ''}
      <button class="btn" type="button" id="theme" title="Light or dark theme">◐ Theme</button>
    </div>`;
  page.appendChild(head);
  page.appendChild(el('div', { class: 'sub' }, `Report generated ${esc(DATA.generatedAt.slice(0, 16).replace('T', ' '))} UTC · positions from ${D.source === 'revert' ? 'Revert Finance' : 'on-chain reads'}${DATA.candles.length ? ' · candles from GeckoTerminal' : ''}`));

  // ---------- KPI tiles ----------
  const kpis = el('section', { class: 'kpis', 'aria-label': 'Key figures' });
  const tile = (label, value, note, cls) => kpis.appendChild(el('div', { class: 'kpi' }, `<div class="label">${esc(label)}</div><div class="value num ${cls || ''}">${value}</div><div class="note">${note || '&nbsp;'}</div>`));
  if (D.active) tile('Position value', usd(D.holdings.valueUsd), finite(D.holdings.valueQuote) ? `${num(D.holdings.valueQuote)} ${esc(QUOTE)}` : '');
  else tile('Withdrawn', usd(perf.withdrawnUsd), `deposited ${usd(perf.depositedUsd)}`);
  if (D.historyAvailable) {
    tile('Profit / loss', signedUsd(perf.pnlUsd), finite(perf.pnlPct) ? `${pct(perf.pnlPct)} of deposits` : '', tone(perf.pnlUsd));
    tile('Fees earned', usd(perf.feesUsd), finite(perf.feesPerDayUsd) ? `${usd(perf.feesPerDayUsd)} per day` : '');
    tile('Fee APR', finite(perf.feeAprPct) ? `${perf.feeAprPct.toFixed(2)}%` : MISSING, finite(perf.totalAprPct) ? `total ${pct(perf.totalAprPct)} a year` : '');
    tile('Impermanent loss', signedUsd(perf.ilUsd), finite(perf.feesCoverIlPct) ? `fees cover ${perf.feesCoverIlPct.toFixed(0)}%` : 'fees excluded', tone(perf.ilUsd));
  } else tile('Unclaimed fees', usd(D.flows.uncollected.usd), 'on-chain data: no history');
  const H = D.history;
  tile('Time in range', H && finite(H.inRangePct) ? `${H.inRangePct.toFixed(1)}%` : MISSING, H && finite(H.exits) ? `${H.exits} exit${H.exits === 1 ? '' : 's'} · ${span(perf.daysHeld)} held` : span(perf.daysHeld));
  page.appendChild(kpis);

  // ---------- range gauge ----------
  function gauge() {
    const card = el('section', { class: 'card gauge' });
    card.innerHTML = `<h2>Range</h2><p class="desc">Where the price is against the range, on a log scale as ticks are. Outside the range the position earns no fees and holds one token.</p>`;
    const box = svg('svg', { viewBox: '0 0 1000 96', preserveAspectRatio: 'none', role: 'img', 'aria-label': `Range ${num(P.lower)} to ${num(P.upper)} ${D.unit}` });
    const marks = [P.lower, P.upper, P.entry, exitOrNow, perf.breakeven].filter(finite);
    let lo = Math.min(...marks);
    let hi = Math.max(...marks);
    const pad = Math.log(hi / lo) * 0.12 || 0.05;
    lo /= Math.exp(pad);
    hi *= Math.exp(pad);
    const x = (p) => 20 + Math.log(p / lo) / Math.log(hi / lo) * 960;
    box.appendChild(svg('rect', { x: 20, y: 44, width: 960, height: 8, rx: 4, fill: css('--grid') }));
    box.appendChild(svg('rect', { x: x(P.lower), y: 40, width: Math.max(2, x(P.upper) - x(P.lower)), height: 16, rx: 4, fill: css('--band'), stroke: css('--band-line') }));
    const mark = (p, label, color, above, shape) => {
      if (!finite(p)) return;
      const cx = x(p);
      box.appendChild(svg('line', { x1: cx, x2: cx, y1: above ? 26 : 56, y2: above ? 40 : 70, stroke: color, 'stroke-width': 2 }));
      if (shape === 'dot') box.appendChild(svg('circle', { cx, cy: 48, r: 7, fill: color, stroke: css('--surface'), 'stroke-width': 2 }));
      const t = svg('text', { x: cx, y: above ? 18 : 86, 'text-anchor': cx < 90 ? 'start' : cx > 910 ? 'end' : 'middle', fill: color, 'font-size': 12, 'font-weight': 600 });
      t.textContent = `${label} ${num(p)}`;
      box.appendChild(t);
    };
    mark(P.lower, 'Lower', css('--band-line'), true);
    mark(P.upper, 'Upper', css('--band-line'), true);
    mark(P.entry, 'Entry', css('--entry'), false);
    if (finite(perf.breakeven) && Math.abs(x(perf.breakeven) - x(P.entry ?? -1)) > 60) mark(perf.breakeven, 'Breakeven', css('--breakeven'), false);
    if (finite(exitOrNow)) mark(exitOrNow, D.active ? 'Now' : 'Exit', D.active ? css('--now') : css('--exit'), Math.abs(x(exitOrNow) - x(P.lower)) > 110 && Math.abs(x(exitOrNow) - x(P.upper)) > 110, 'dot');
    // Labels above can collide when the price sits near a limit: then the price label goes below.
    card.appendChild(box);
    const facts = [
      ['Width', `${P.widthPct.toFixed(2)}%`],
      D.active && finite(P.toLowerPct) ? ['To lower', pct(P.toLowerPct, 1)] : null,
      D.active && finite(P.toUpperPct) ? ['To upper', pct(P.toUpperPct, 1)] : null,
      D.active && D.status === 'in' && finite(P.rangePositionPct) ? ['Through the range', `${P.rangePositionPct.toFixed(0)}%`] : null,
      finite(P.lowerFromEntryPct) ? ['Limits from entry', `${pct(P.lowerFromEntryPct, 1)} / ${pct(P.upperFromEntryPct, 1)}`] : null,
      finite(D.liquidity.efficiency) ? ['Concentration', `${D.liquidity.efficiency.toFixed(1)}× full range${D.active ? '' : ' at entry'}`] : null,
      H && (finite(H.daysToLower) || finite(H.daysToUpper)) ? ['Typical time to a limit', `lower ${span(H.daysToLower)} · upper ${span(H.daysToUpper)}`] : null,
    ].filter(Boolean);
    card.appendChild(el('div', { class: 'gauge-facts' }, facts.map(([k, v]) => `<span>${esc(k)} <b class="num">${v}</b></span>`).join('')));
    return card;
  }
  page.appendChild(gauge());

  // ---------- price chart ----------
  const candles = DATA.candles.map(([time, open, high, low, close, volume, filled]) => ({ time, open, high, low, close, volume, filled: filled === 1 }));
  const SIZES = [['15m', 900], ['1h', 3600], ['4h', 14400], ['1D', 86400]];
  let step = DATA.step;
  let chart = null;
  let mainSeries = null;
  let shown = candles;
  function resample(rows, size) {
    if (size === DATA.step) return rows;
    const out = [];
    for (const c of rows) {
      const t = c.time - (c.time % size);
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; last.filled = last.filled && c.filled;
      } else out.push({ ...c, time: t });
    }
    return out;
  }
  function priceCard() {
    const card = el('section', { class: 'card' });
    const choices = SIZES.filter(([, size]) => size >= DATA.step && size % DATA.step === 0 && candles.length && (candles[candles.length - 1].time - candles[0].time) / size >= 8);
    card.innerHTML = `<div class="card-head"><div class="grow"><h2>Price · ${esc(D.unit)}</h2><p class="desc">The pool's candles with the range shaded while the position was open, its entry${D.active ? '' : ', exit'}${finite(perf.breakeven) ? ', breakeven' : ''} and every transaction. Scroll to zoom, drag to pan, hover for values.</p></div>
      <div class="tfs" id="timeframes" role="group" aria-label="Timeframe">${choices.map(([label, size]) => `<button class="btn" type="button" data-size="${size}" aria-pressed="${size === step}">${label}</button>`).join('')}
      <button class="btn" type="button" id="fit" title="Show the whole chart">Fit</button></div></div>
      <div class="price-wrap"><div id="price-chart"></div><canvas id="band"></canvas><div class="legend" id="legend"></div></div>
      <div class="keys">
        <span class="key"><span class="swatch box"></span>Range while open</span>
        <span class="key" style="color:var(--entry)"><span class="swatch dash"></span>Entry</span>
        ${D.active ? '' : '<span class="key" style="color:var(--exit)"><span class="swatch dash"></span>Exit</span>'}
        ${finite(perf.breakeven) ? '<span class="key" style="color:var(--breakeven)"><span class="swatch dash"></span>Breakeven</span>' : ''}
        <span class="key"><span class="dot" style="background:var(--lp)"></span>Deposit</span>
        <span class="key"><span class="dot" style="background:var(--breakeven)"></span>Fee collect</span>
        <span class="key"><span class="dot" style="background:var(--exit)"></span>Withdrawal</span>
      </div>`;
    return card;
  }
  function buildChart() {
    const host = document.getElementById('price-chart');
    const text = css('--text-2');
    chart = LightweightCharts.createChart(host, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 0 },
      localization: { timeFormatter: (t) => when(t) },
    });
    const digits = (() => { const p = P.middle; return p >= 1000 ? 2 : p >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(p))); })();
    mainSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: css('--up'), downColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down'), borderVisible: false,
      priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits },
      // Keep the range in view, not only the candles.
      autoscaleInfoProvider: (original) => {
        const res = original();
        if (!res) return res;
        const extra = [P.lower, P.upper, P.entry, D.active ? undefined : P.exit].filter(finite);
        return { priceRange: { minValue: Math.min(res.priceRange.minValue, ...extra), maxValue: Math.max(res.priceRange.maxValue, ...extra) }, margins: res.margins };
      },
    });
    const line = (price, color, title, style) => finite(price) && mainSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    line(P.upper, css('--band-line'), 'Upper', 0);
    line(P.lower, css('--band-line'), 'Lower', 0);
    line(P.entry, css('--entry'), 'Entry', 2);
    if (!D.active) line(P.exit, css('--exit'), 'Exit', 2);
    line(perf.breakeven, css('--breakeven'), 'Breakeven', 2);
    setData(step);
    chart.subscribeCrosshairMove(legend);
    legend();
    requestAnimationFrame(drawBand);
  }
  function setData(size) {
    step = size;
    shown = resample(candles, size);
    const gray = css('--muted');
    mainSeries.setData(shown.map((c) => c.filled ? { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, color: gray, wickColor: gray } : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    const colors = { deposit: css('--lp'), withdraw: css('--exit'), collect: css('--breakeven') };
    const names = { deposit: 'Deposit', withdraw: 'Withdraw', collect: 'Collect' };
    const times = shown.map((c) => c.time);
    const snap = (t) => { let best = times[0]; for (const x of times) if (x <= t) best = x; return best; };
    const markers = D.events.filter(() => times.length).map((e) => ({
      time: snap(e.timestamp), position: e.kind === 'withdraw' ? 'aboveBar' : 'belowBar', color: colors[e.kind],
      shape: e.kind === 'deposit' ? 'arrowUp' : e.kind === 'withdraw' ? 'arrowDown' : 'circle', text: names[e.kind],
    })).filter((m) => m.time >= times[0] && m.time <= times[times.length - 1]).sort((a, b) => a.time - b.time);
    if (window.__markers) window.__markers.setMarkers(markers);
    else window.__markers = LightweightCharts.createSeriesMarkers(mainSeries, markers);
    document.querySelectorAll('#timeframes [data-size]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === size)));
    chart.timeScale().fitContent();
    drawBand();
  }
  // The range band: drawn on a canvas over the chart, from the opening to the close (or the latest candle).
  function drawBand() {
    const canvas = document.getElementById('band');
    if (!canvas || !chart) return;
    const host = document.getElementById('price-chart');
    const width = chart.timeScale().width();
    const height = host.clientHeight - chart.timeScale().height();
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!shown.length) return;
    const yTop = mainSeries.priceToCoordinate(P.upper);
    const yBottom = mainSeries.priceToCoordinate(P.lower);
    if (yTop === null || yBottom === null) return;
    const first = shown[0].time;
    const start = D.openedAt ? Date.parse(D.openedAt) / 1000 : first;
    const end = D.closedAt ? Date.parse(D.closedAt) / 1000 : shown[shown.length - 1].time + step;
    const ts = chart.timeScale();
    // logicalToCoordinate takes whole bars only (fractions come back as 0): interpolate between bars.
    const at = (logical) => { const whole = Math.floor(logical); const a = ts.logicalToCoordinate(whole); const b = ts.logicalToCoordinate(whole + 1); return a === null || b === null ? null : a + (b - a) * (logical - whole); };
    const xs = at((start - first) / step - 0.5);
    const xe = at((end - first) / step - 0.5);
    if (xs === null || xe === null) return;
    const left = Math.max(0, xs);
    const right = Math.min(width, xe);
    if (right <= left) return;
    ctx.fillStyle = css('--band');
    ctx.fillRect(left, Math.min(yTop, yBottom), right - left, Math.abs(yBottom - yTop));
    ctx.strokeStyle = css('--band-line');
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const xLine of [xs, xe]) if (xLine >= 0 && xLine <= width) { ctx.moveTo(xLine, 0); ctx.lineTo(xLine, height); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  function legend(param) {
    const box = document.getElementById('legend');
    const c = param && param.time !== undefined ? shown.find((x) => x.time === param.time) : shown[shown.length - 1];
    if (!c) { box.innerHTML = ''; return; }
    const inRange = c.close >= P.lower && c.close <= P.upper;
    const change = (c.close / c.open - 1) * 100;
    box.innerHTML = `<b>${esc(D.pair)}</b> · ${SIZES.find(([, s]) => s === step)?.[0] ?? ''} · ${when(c.time)} &nbsp; O <b class="num">${num(c.open)}</b> H <b class="num">${num(c.high)}</b> L <b class="num">${num(c.low)}</b> C <b class="num">${num(c.close)}</b> <span class="${tone(change)}">${pct(change)}</span> · ${inRange ? '<span class="pos">in range</span>' : '<span class="neg">out of range</span>'}${c.filled ? ' · no trades' : ''}`;
  }
  if (DATA.plot) {
    const card = priceCard();
    page.appendChild(card);
    if (candles.length && window.LightweightCharts) {
      buildChart();
      card.querySelectorAll('#timeframes [data-size]').forEach((b) => b.addEventListener('click', () => setData(Number(b.dataset.size))));
      card.querySelector('#fit').addEventListener('click', () => chart.timeScale().fitContent());
      // Redraw the band whenever the chart scrolls, zooms, rescales or resizes.
      let last = '';
      const watch = () => { const range = chart.timeScale().getVisibleLogicalRange(); const key = `${mainSeries.priceToCoordinate(P.upper)}:${mainSeries.priceToCoordinate(P.lower)}:${range && range.from}:${range && range.to}:${chart.timeScale().width()}`; if (key !== last) { last = key; drawBand(); } requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    } else card.querySelector('.price-wrap').innerHTML = `<div class="empty">Price chart unavailable${DATA.dataNote ? `: ${esc(DATA.dataNote)}` : ''}.</div>`;
  }

  // ---------- SVG line charts ----------
  /**
   * A line chart over price (log x) with hover: one crosshair per chart, synced across charts through `hub`.
   * series: [{ key, label, color, dash, values: number[] }] over xs; yFormat formats the axis and tooltip.
   */
  const hub = [];
  function lineChart(host, options) {
    const W = 640;
    const Hh = options.height || 260;
    const m = { l: 64, r: 14, t: 12, b: 28 };
    const xs = options.xs;
    const all = options.series.flatMap((s) => s.values).filter(finite);
    let y0 = Math.min(...all, options.yMin ?? Infinity);
    let y1 = Math.max(...all, options.yMax ?? -Infinity);
    if (!(y1 > y0)) { y1 += 1; y0 -= 1; }
    const padY = (y1 - y0) * 0.06;
    y0 -= padY; y1 += padY;
    const [x0, x1] = [xs[0], xs[xs.length - 1]];
    const X = (p) => m.l + Math.log(p / x0) / Math.log(x1 / x0) * (W - m.l - m.r);
    const Y = (v) => m.t + (y1 - v) / (y1 - y0) * (Hh - m.t - m.b);
    const root = svg('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': options.label });
    const grid = svg('g', { class: 'grid' });
    for (let i = 0; i <= 4; i += 1) {
      const v = y0 + (y1 - y0) * i / 4;
      grid.appendChild(svg('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
      const t = svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' });
      t.textContent = options.yFormat(v);
      grid.appendChild(t);
    }
    root.appendChild(grid);
    // In-range region.
    root.appendChild(svg('rect', { x: X(P.lower), y: m.t, width: Math.max(1, X(P.upper) - X(P.lower)), height: Hh - m.t - m.b, fill: css('--band') }));
    if (options.zero) root.appendChild(svg('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: css('--muted'), 'stroke-width': 1 }));
    // x axis labels: five log-spaced prices.
    for (let i = 0; i <= 4; i += 1) {
      const p = x0 * (x1 / x0) ** (i / 4);
      const t = svg('text', { x: X(p), y: Hh - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' });
      t.textContent = num(p);
      root.appendChild(t);
    }
    // Vertical markers; labels that would overlap move down a row.
    const placed = [];
    const vline = (p, color, label, dash) => {
      if (!finite(p) || p < x0 || p > x1) return;
      root.appendChild(svg('line', { x1: X(p), x2: X(p), y1: m.t, y2: Hh - m.b, stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dash ? '4 4' : null }));
      const widthText = label.length * 6.5 + 8;
      let row = 0;
      while (placed.some((q) => q.row === row && Math.abs(q.x - X(p)) < Math.max(q.w, widthText))) row += 1;
      placed.push({ x: X(p), w: widthText, row });
      const t = svg('text', { x: X(p) + 4, y: m.t + 11 + row * 13, fill: color, 'font-size': 11, 'font-weight': 600 });
      t.textContent = label;
      root.appendChild(t);
    };
    const marks = [[P.lower, css('--band-line'), 'Lower'], [P.upper, css('--band-line'), 'Upper'], [P.entry, css('--entry'), 'Entry', true],
      [exitOrNow, D.active ? css('--now') : css('--exit'), D.active ? 'Now' : 'Exit', true]].filter(([p]) => finite(p)).sort((a, b) => a[0] - b[0]);
    for (const [p, color, label, dash] of marks) vline(p, color, label, dash);
    for (const s of options.series) {
      const d = xs.map((p, i) => `${i ? 'L' : 'M'}${X(p).toFixed(1)},${Y(s.values[i]).toFixed(1)}`).join('');
      root.appendChild(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash ? '6 4' : null, 'stroke-linejoin': 'round' }));
    }
    const cross = svg('line', { y1: m.t, y2: Hh - m.b, stroke: css('--muted'), 'stroke-width': 1, visibility: 'hidden' });
    root.appendChild(cross);
    const dots = options.series.map((s) => { const c = svg('circle', { r: 4, fill: s.color, stroke: css('--surface'), 'stroke-width': 2, visibility: 'hidden' }); root.appendChild(c); return c; });
    const hit = svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: Hh - m.t - m.b, fill: 'transparent' });
    root.appendChild(hit);
    host.appendChild(root);
    const show = (i, event) => {
      cross.setAttribute('x1', X(xs[i])); cross.setAttribute('x2', X(xs[i])); cross.setAttribute('visibility', 'visible');
      dots.forEach((c, k) => { c.setAttribute('cx', X(xs[i])); c.setAttribute('cy', Y(options.series[k].values[i])); c.setAttribute('visibility', 'visible'); });
      if (event) showTip(event, options.tooltip(i));
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((c) => c.setAttribute('visibility', 'hidden')); };
    const entry = { show, hide };
    hub.push(entry);
    const index = (event) => {
      const r = root.getBoundingClientRect();
      const px = (event.clientX - r.left) / r.width * W;
      const p = x0 * (x1 / x0) ** ((px - m.l) / (W - m.l - m.r));
      let best = 0;
      xs.forEach((x, i) => { if (Math.abs(Math.log(x / p)) < Math.abs(Math.log(xs[best] / p))) best = i; });
      return best;
    };
    hit.addEventListener('pointermove', (event) => { const i = index(event); hub.forEach((h) => h === entry ? h.show(i, event) : h.show(i)); });
    hit.addEventListener('pointerleave', () => { hub.forEach((h) => h.hide()); hideTip(); });
    return entry;
  }

  // ---------- value against price + impermanent loss ----------
  if (DATA.plot && D.curve.length) {
    const xs = D.curve.map((c) => c.price);
    const refLabel = D.curveReference === P.entry ? 'entry' : 'the current price';
    const from = D.liquidity.curveFrom === 'deposit' ? 'the liquidity it was opened with' : 'its current liquidity';
    const tooltip = (i) => {
      const c = D.curve[i];
      return tipRows(`${num(c.price)} ${D.unit}`, [
        ['Position', `${num(c.value)} ${esc(QUOTE)}`], ['Holding instead', `${num(c.hodl)} ${esc(QUOTE)}`], ['vs holding', pct(c.ilPct)],
        [BASE, num(c.base)], [QUOTE, num(c.quote)], ['Range', c.price >= P.lower && c.price <= P.upper ? 'in' : 'out'],
        finite(now) ? ['From now', pct((c.price / now - 1) * 100, 1)] : null,
      ]);
    };
    const card = el('section', { class: 'grid2' });
    const a = el('div', { class: 'card' }, `<h2>Value against price · ${esc(QUOTE)}</h2><p class="desc">What the position is worth at each price, with ${from}, against holding the tokens it had at ${refLabel}. Concave: it sells ${esc(BASE)} as the price rises and buys it as it falls.</p><div class="svgchart" id="value-chart"></div>
      <div class="keys"><span class="key" style="color:var(--lp)"><span class="swatch"></span>Position</span><span class="key" style="color:var(--hodl)"><span class="swatch dash"></span>Holding the tokens</span><span class="key"><span class="swatch box"></span>In range</span></div>`);
    const b = el('div', { class: 'card' }, `<h2>Impermanent loss against price</h2><p class="desc">The position against holding, in percent, fees excluded. It deepens inside the range and stops changing beyond it, where the position holds one token.</p><div class="svgchart" id="il-chart"></div>
      <div class="keys"><span class="key" style="color:var(--lp)"><span class="swatch"></span>Position vs holding</span></div>`);
    card.append(a, b);
    page.appendChild(card);
    lineChart(a.querySelector('#value-chart'), { xs, label: 'Position value against price', yFormat: num, tooltip,
      series: [{ key: 'hodl', color: css('--hodl'), dash: true, values: D.curve.map((c) => c.hodl) }, { key: 'value', color: css('--lp'), values: D.curve.map((c) => c.value) }] });
    lineChart(b.querySelector('#il-chart'), { xs, label: 'Impermanent loss against price', yFormat: (v) => `${v.toFixed(1)}%`, tooltip, zero: true, yMax: 0,
      series: [{ key: 'il', color: css('--lp'), values: D.curve.map((c) => c.ilPct) }] });
  }

  // ---------- composition and PnL attribution ----------
  function donut(host, parts, center) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    const root = svg('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${(p.value / total * 100).toFixed(1)}%`).join(', ') });
    let angle = -Math.PI / 2;
    const R = 86;
    const r = 58;
    for (const part of parts) {
      const share = total ? part.value / total : 0;
      if (share <= 0) continue;
      const a1 = angle + share * Math.PI * 2 - (share < 1 ? 0.02 : 0);
      const large = share > 0.5 ? 1 : 0;
      const path = share >= 0.999
        ? `M100,${100 - R}A${R},${R} 0 1 1 99.99,${100 - R}L99.99,${100 - r}A${r},${r} 0 1 0 100,${100 - r}Z`
        : `M${100 + R * Math.cos(angle)},${100 + R * Math.sin(angle)}A${R},${R} 0 ${large} 1 ${100 + R * Math.cos(a1)},${100 + R * Math.sin(a1)}L${100 + r * Math.cos(a1)},${100 + r * Math.sin(a1)}A${r},${r} 0 ${large} 0 ${100 + r * Math.cos(angle)},${100 + r * Math.sin(angle)}Z`;
      const seg = svg('path', { d: path, fill: part.color });
      seg.addEventListener('pointermove', (event) => showTip(event, tipRows(part.label, [['Amount', part.amount], ['Value', part.valueText], ['Share', `${(share * 100).toFixed(1)}%`]])));
      seg.addEventListener('pointerleave', hideTip);
      root.appendChild(seg);
      angle += share * Math.PI * 2;
    }
    const t = svg('text', { x: 100, y: 98, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 650, fill: css('--text') });
    t.textContent = center[0];
    const s = svg('text', { x: 100, y: 118, 'text-anchor': 'middle', 'font-size': 11, fill: css('--muted') });
    s.textContent = center[1];
    root.append(t, s);
    host.appendChild(root);
  }
  const grid2 = el('section', { class: 'grid2' });
  {
    const card = el('div', { class: 'card' });
    // Open: what it holds now. Closed: what it returned at the exit.
    const [b, q, priceFor, title] = D.active
      ? [D.holdings.base, D.holdings.quote, P.current, 'Holdings now']
      : [D.flows.withdrawn.base, D.flows.withdrawn.quote, P.exit, 'Tokens withdrawn'];
    card.innerHTML = `<h2>${title}</h2><p class="desc">${D.active ? 'The tokens the liquidity holds at the current price, by value.' : 'What the position returned when it was closed, by value at the exit price.'}</p>
      <div class="holdings" style="display:grid;grid-template-columns:minmax(140px,200px) minmax(0,1fr);gap:16px;align-items:center"><div class="svgchart" id="donut"></div><div id="hold-table"></div></div>`;
    grid2.appendChild(card);
    if (finite(b) && finite(q) && finite(priceFor) && b * priceFor + q > 0) {
      const quoteUsd = D.quote.priceUsd;
      const baseValue = b * priceFor;
      donut(card.querySelector('#donut'), [
        { label: BASE, value: baseValue, color: css('--lp'), amount: `${num(b)} ${esc(BASE)}`, valueText: `${num(baseValue)} ${esc(QUOTE)}` },
        { label: QUOTE, value: q, color: css('--hodl'), amount: `${num(q)} ${esc(QUOTE)}`, valueText: `${num(q)} ${esc(QUOTE)}` },
      ], [`${(baseValue / (baseValue + q) * 100).toFixed(0)}%`, `${BASE} by value`]);
      card.querySelector('#hold-table').innerHTML = `<table class="kv"><tbody>
        <tr><td><span class="dot" style="background:var(--lp)"></span> ${esc(BASE)}</td><td class="num">${num(b)}</td></tr>
        <tr><td><span class="dot" style="background:var(--hodl)"></span> ${esc(QUOTE)}</td><td class="num">${num(q)}</td></tr>
        <tr><td>Value</td><td class="num">${num(baseValue + q)} ${esc(QUOTE)}${finite(quoteUsd) ? ` · ${usd((baseValue + q) * quoteUsd)}` : ''}</td></tr>
        ${D.active ? `<tr><td>Unclaimed fees</td><td class="num">${usd(D.flows.uncollected.usd)}</td></tr>` : `<tr><td>Deposited</td><td class="num">${num(D.flows.deposited.base)} ${esc(BASE)} + ${num(D.flows.deposited.quote)} ${esc(QUOTE)}</td></tr>`}
        <tr><td>Fees collected</td><td class="num">${num(D.flows.collected.base)} ${esc(BASE)} + ${num(D.flows.collected.quote)} ${esc(QUOTE)}</td></tr>
      </tbody></table>`;
    } else card.querySelector('#donut').parentElement.innerHTML = '<div class="empty">No token amounts to show.</div>';
  }
  if (D.historyAvailable) {
    const card = el('div', { class: 'card' });
    // Attribution: market move (holding the deposited tokens) + the liquidity's effect (impermanent loss) + fees − gas = PnL.
    const steps = [];
    if (finite(perf.hodlUsd) && finite(perf.depositedUsd) && finite(perf.pnlUsd)) {
      const market = perf.hodlUsd - perf.depositedUsd;
      const fees = perf.feesUsd || 0;
      const gas = perf.gasUsd || 0;
      steps.push(['Market move', market, 'The deposited tokens, held instead, against what they were worth when deposited.'],
        ['Liquidity effect', perf.pnlUsd - market - fees + gas, 'Impermanent loss: the position against holding, fees excluded.'],
        ['Fees earned', fees, 'Collected and unclaimed.'], ['Gas', -gas, 'Transaction fees for the position.']);
    } else {
      steps.push(['Value now', perf.valueUsd || 0], ['Withdrawn', perf.withdrawnUsd || 0], ['Fees earned', perf.feesUsd || 0], ['Gas', -(perf.gasUsd || 0)], ['Deposited', -(perf.depositedUsd || 0)]);
    }
    card.innerHTML = `<h2>Where the PnL came from</h2><p class="desc">Each step adds to the one before; the last bar is the lifetime PnL of ${signedUsd(perf.pnlUsd)}. Hover a bar for details.</p><div class="svgchart" id="waterfall"></div>`;
    grid2.appendChild(card);
    const W = 640;
    const Hh = 260;
    const m = { l: 64, r: 10, t: 14, b: 34 };
    const bars = [];
    let run = 0;
    for (const [label, value, note] of steps) { bars.push({ label, from: run, to: run + value, value, note }); run += value; }
    bars.push({ label: 'PnL', from: 0, to: run, value: run, total: true, note: 'Lifetime profit or loss.' });
    const vals = bars.flatMap((b) => [b.from, b.to, 0]);
    let y0 = Math.min(...vals);
    let y1 = Math.max(...vals);
    if (!(y1 > y0)) { y1 += 1; y0 -= 1; }
    const pad = (y1 - y0) * 0.12;
    y0 -= pad; y1 += pad;
    const Y = (v) => m.t + (y1 - v) / (y1 - y0) * (Hh - m.t - m.b);
    const root = svg('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': bars.map((b) => `${b.label} ${signedUsd(b.value)}`).join(', ') });
    for (let i = 0; i <= 4; i += 1) {
      const v = y0 + (y1 - y0) * i / 4;
      root.appendChild(svg('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: css('--grid') }));
      const t = svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' });
      t.textContent = usd(v);
      root.appendChild(t);
    }
    root.appendChild(svg('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: css('--muted') }));
    const slot = (W - m.l - m.r) / bars.length;
    bars.forEach((b, i) => {
      const x = m.l + slot * i + slot * 0.18;
      const w = slot * 0.64;
      const top = Y(Math.max(b.from, b.to));
      const h = Math.max(2, Math.abs(Y(b.from) - Y(b.to)));
      const color = b.total ? (b.value >= 0 ? css('--good') : css('--bad')) : b.value >= 0 ? css('--lp') : css('--hodl');
      const rect = svg('rect', { x, y: top, width: w, height: h, rx: 3, fill: color });
      rect.addEventListener('pointermove', (event) => showTip(event, tipRows(b.label, [['Amount', signedUsd(b.value)], b.total ? null : ['Running total', signedUsd(b.to)]]) + (b.note ? `<div class="sub" style="margin-top:4px;max-width:220px;white-space:normal">${esc(b.note)}</div>` : '')));
      rect.addEventListener('pointerleave', hideTip);
      root.appendChild(rect);
      if (i < bars.length - 1) root.appendChild(svg('line', { x1: x + w, x2: x + slot, y1: Y(b.to), y2: Y(b.to), stroke: css('--muted'), 'stroke-dasharray': '2 3' }));
      const value = svg('text', { x: x + w / 2, y: top - 4, 'text-anchor': 'middle', class: 'label-strong' });
      value.textContent = signedUsd(b.value);
      const label = svg('text', { x: x + w / 2, y: Hh - 12, 'text-anchor': 'middle' });
      label.textContent = b.label;
      root.append(value, label);
    });
    card.querySelector('#waterfall').appendChild(root);
  }
  page.appendChild(grid2);

  // ---------- key-value tables ----------
  const kv = (title, rows, desc) => el('div', { class: 'card' }, `<h2>${esc(title)}</h2>${desc ? `<p class="desc">${desc}</p>` : ''}<table class="kv"><tbody>${rows.filter(Boolean).map(([k, v, cls]) => `<tr><td>${esc(k)}</td><td class="num ${cls || ''}">${v}</td></tr>`).join('')}</tbody></table>`);
  const facts = el('section', { class: 'grid3' });
  facts.appendChild(kv('Range and price', [
    ['Lower limit', `${num(P.lower)}${D.active && finite(P.toLowerPct) ? ` <span class="sub">${pct(P.toLowerPct, 1)}</span>` : ''}`],
    ['Upper limit', `${num(P.upper)}${D.active && finite(P.toUpperPct) ? ` <span class="sub">${pct(P.toUpperPct, 1)}</span>` : ''}`],
    ['Middle (geometric)', num(P.middle)],
    ['Price now', num(finite(P.live) ? P.live : P.current)],
    ['Entry price', num(P.entry)],
    finite(P.averageEntry) && P.averageEntry !== P.entry ? ['Average entry', num(P.averageEntry)] : null,
    D.active ? null : ['Exit price', num(P.exit)],
    ['Range width', `${P.widthPct.toFixed(2)}%`],
    ['Ticks', `${D.tickLower} → ${D.tickUpper}`],
    finite(D.currentTick) ? ['Current tick', String(D.currentTick)] : null,
    finite(D.tickSpacing) ? ['Tick spacing', String(D.tickSpacing)] : null,
    ['Concentration', finite(D.liquidity.efficiency) ? `${D.liquidity.efficiency.toFixed(1)}× full range${D.active ? '' : ' <span class="sub">at entry</span>'}` : MISSING],
    ['Liquidity', `<span title="${esc(D.liquidity.raw)}">${esc(D.liquidity.raw.length > 18 ? Number(D.liquidity.raw).toExponential(4) : D.liquidity.raw)}</span>`],
  ], 'Prices in ' + esc(D.unit) + '.'));
  if (D.historyAvailable) facts.appendChild(kv('Performance', [
    ['Deposited', usd(perf.depositedUsd)],
    ['Withdrawn', usd(perf.withdrawnUsd)],
    ['Value now', usd(perf.valueUsd)],
    ['Fees earned', usd(perf.feesUsd)],
    ['· collected', usd(D.flows.collected.usd)],
    ['· unclaimed', usd(D.flows.uncollected.usd)],
    ['Gas', usd(perf.gasUsd)],
    ['PnL', `${signedUsd(perf.pnlUsd)} <span class="sub">${pct(perf.pnlPct)}</span>`, tone(perf.pnlUsd)],
    ['Impermanent loss', signedUsd(perf.ilUsd), tone(perf.ilUsd)],
    ['Holding instead', usd(perf.hodlUsd)],
    ['Against holding', signedUsd(perf.vsHodlUsd), tone(perf.vsHodlUsd)],
    ['Fee APR', finite(perf.feeAprPct) ? `${perf.feeAprPct.toFixed(2)}%` : MISSING],
    ['Total APR', pct(perf.totalAprPct)],
    finite(perf.breakeven) ? ['Breakeven price', `above ${num(perf.breakeven)}`] : null,
  ], 'In USD, each flow valued when it happened.'));
  facts.appendChild(kv('Time and risk', [
    ['Opened', `${whenIso(D.openedAt)} UTC`],
    D.closedAt ? ['Closed', `${whenIso(D.closedAt)} UTC`] : null,
    ['Held', span(perf.daysHeld)],
    H ? ['Time in range', `${plainPct(H.inRangePct)} <span class="sub">${esc(H.timeframe)} closes</span>`] : null,
    H ? ['Range exits', finite(H.exits) ? String(H.exits) : MISSING] : null,
    H ? ['High while open', num(H.high)] : null,
    H ? ['Low while open', num(H.low)] : null,
    H ? ['Volatility while open', finite(H.volatilityPct) ? `${H.volatilityPct.toFixed(0)}% a year` : MISSING] : null,
    H ? ['Daily volatility (chart)', finite(H.dailyVolatilityPct) ? `${H.dailyVolatilityPct.toFixed(2)}%` : MISSING] : null,
    H && finite(H.daysToLower) ? ['Typical time to lower', span(H.daysToLower)] : null,
    H && finite(H.daysToUpper) ? ['Typical time to upper', span(H.daysToUpper)] : null,
    H && D.status !== 'in' && H.lastInRangeAt ? ['Last in range', `${when(H.lastInRangeAt)} UTC`] : null,
  ], 'From the pool\'s candles while the position was open.'));
  page.appendChild(facts);

  // ---------- what-if table ----------
  if (D.scenarios.length) {
    const hasPnl = D.scenarios.some((s) => finite(s.pnlUsd));
    const card = el('section', { class: 'card' });
    card.innerHTML = `<h2>What if the price moved now</h2><p class="desc">The position at other prices: its tokens, value, result against holding, and lifetime PnL with the fees earned so far (${esc(QUOTE)} at today's USD price).</p>
      <div class="scroll"><table><thead><tr><th>Move</th><th>Price</th><th>${esc(BASE)}</th><th>${esc(QUOTE)}</th><th>Value</th><th>vs holding</th>${hasPnl ? '<th>Lifetime PnL</th>' : ''}<th>Range</th></tr></thead><tbody>
      ${D.scenarios.map((s) => `<tr class="${s.label === 'Now' ? 'now' : ''} ${s.inRange ? '' : 'out'}"><td>${esc(s.label)}</td><td>${num(s.price)}</td><td>${num(s.base)}</td><td>${num(s.quote)}</td><td>${usd(s.valueUsd)}</td><td class="${tone(s.vsHodlPct)}">${pct(s.vsHodlPct)}</td>${hasPnl ? `<td class="${tone(s.pnlUsd)}">${signedUsd(s.pnlUsd)}</td>` : ''}<td>${s.inRange ? 'in' : 'out'}</td></tr>`).join('')}
      </tbody></table></div>`;
    page.appendChild(card);
  }

  // ---------- transactions ----------
  {
    const card = el('section', { class: 'card' });
    const names = { deposit: 'Deposit', withdraw: 'Withdraw', collect: 'Collect fees' };
    const link = (hash) => D.links.explorer && hash ? `<a href="${esc(D.links.explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(hash.slice(0, 10))}…↗</a>` : hash ? esc(hash.slice(0, 10)) + '…' : MISSING;
    card.innerHTML = `<h2>Transactions (${D.events.length})</h2><p class="desc">Each change to the position, with the pool price and USD value at the time.</p>` + (D.events.length
      ? `<div class="scroll"><table><thead><tr><th>Time (UTC)</th><th>Action</th><th>${esc(BASE)}</th><th>${esc(QUOTE)}</th><th>Price</th><th>Value</th><th>Gas</th><th>Transaction</th></tr></thead><tbody>
        ${D.events.map((e) => `<tr><td>${when(e.timestamp)}</td><td style="text-align:left"><span class="tag ${e.kind}">${names[e.kind]}</span></td><td>${num(e.base)}</td><td>${num(e.quote)}</td><td>${num(e.displayPrice)}</td><td>${usd(e.valueUsd)}</td><td>${finite(e.gasUsd) ? usd(e.gasUsd) : MISSING}</td><td>${link(e.hash)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">No transaction history (on-chain data only).</div>');
    page.appendChild(card);
  }

  // ---------- notes ----------
  const notes = [
    `Prices are ${esc(D.unit)}: the quote is a stablecoin or the wrapped native coin when the pair has one.`,
    D.historyAvailable ? 'PnL: value now + withdrawals + fees − deposits − gas, each in USD when it happened. Impermanent loss excludes fees: what the position returned minus the deposited tokens, at the exit prices (today\'s for an open position). Against holding: what the position returned, with fees and after gas, minus the deposited tokens held instead.' : 'On-chain data only: deposits, withdrawals, fees earned, PnL and dates are unknown.',
    'Value against price uses the concentrated-liquidity formulas for the position\'s liquidity; it ignores fees, so it shows the price risk alone.',
    'Time in range counts candle closes inside the range while the position was open. Typical time to a limit is (distance ÷ daily volatility)² days, how long a random walk usually takes to move that far, not a forecast.',
    DATA.dataNote ? esc(DATA.dataNote) : null,
  ].filter(Boolean);
  page.appendChild(el('footer', { class: 'notes' }, notes.map((n) => `<p>${n}</p>`).join('')));

  // ---------- theme ----------
  const root = document.documentElement;
  document.getElementById('theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('position-report-theme', root.dataset.theme); } catch (e) { /* storage blocked */ }
    location.reload();
  });

  window.positionReport = {
    detail: D,
    step: () => step,
    setTimeframe: (size) => setData(size),
    shownCandles: () => shown.map((c) => ({ ...c })),
    chartReady: () => Boolean(chart),
    chart: () => chart,
  };
})();

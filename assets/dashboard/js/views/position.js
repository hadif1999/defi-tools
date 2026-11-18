import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, signedUsd, pct, num, tone, fee, day, duration } from '../format.js';
import { kpi, badge, cliHint, segmented, errorBox, notesBanner, skeleton, copyButton } from '../ui.js';
import { walletParams } from '../state.js';
import { events } from '../events.js';
import { external, mountFrame } from './common.js';

// One position in depth: the key figures and live price here, and the full positions detail report (range gauge,
// price chart with the range band, value against price, IL curve, PnL attribution, transactions) in a frame.

const STATUS = { in: ['In range', 'up'], below: ['Below range', 'down'], above: ['Above range', 'down'], closed: ['Closed', ''] };

export async function render(root, ctx) {
  const { id, chain, past } = ctx.params;
  if (!id) { ctx.navigate('positions'); return; }
  let timeframe = ctx.params.timeframe ?? 'auto';
  const params = () => ({ ref: `#${id}`, chain, past: past ? 1 : undefined, timeframe, ...walletParams() });
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, `Position #${id}`), h('p', null, 'Loading…')));
  const notes = h('div');
  const kpis = h('div', { class: 'kpis' }, skeleton(2));
  const live = h('span', { class: 'badge', hidden: true });
  const frameWrap = h('div', { class: 'frame-wrap' });
  const hint = h('div');
  root.append(h('button', { class: 'btn ghost sm', style: { justifySelf: 'start' }, onclick: () => history.length > 1 ? history.back() : ctx.navigate('positions') }, icon('back'), 'Positions'), head, notes, kpis,
    h('div', { class: 'toolbar' }, h('b', null, 'Report'), segmented([['auto', 'Auto'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', '1d']], timeframe, (next) => { timeframe = next; ctx.replaceParams({ id, chain, past, timeframe }); load(); }, { label: 'Candle size' }),
      h('span', { class: 'grow' }), live, h('a', { class: 'btn sm', id: 'open-report', target: '_blank', rel: 'noopener' }, icon('external'), 'Open report in a tab')),
    frameWrap, hint);

  let controller;
  let unsubscribe;
  let stopFrame;
  async function load({ force = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const query = new URLSearchParams(Object.entries(params()).filter(([, value]) => value !== undefined && value !== ''));
    if (force) query.set('refresh', '1');
    root.querySelector('#open-report').href = `/report/position?${query}`;
    // The frame and the summary share one cached analysis on the server.
    clear(frameWrap).append(h('div', { class: 'loading' }, h('div', { style: { display: 'grid', gap: '10px', justifyItems: 'center' } }, h('div', { class: 'progress', style: { width: '180px' } }, h('div')), 'Building the report: positions, candles and analysis…')));
    stopFrame?.();
    stopFrame = mountFrame(frameWrap, () => {
    const frame = h('iframe', { class: 'frame', title: `Position #${id} report`, style: { height: '2400px' }, src: `/report/position?${query}` });
    frame.addEventListener('load', () => {
      frameWrap.querySelector('.loading')?.remove();
      // Fit the frame to the report so the page scrolls as one.
      try {
        const doc = frame.contentDocument;
        const fit = () => { frame.style.height = `${Math.max(600, doc.documentElement.scrollHeight + 4)}px`; };
        fit();
        new ResizeObserver(fit).observe(doc.body);
      } catch { /* not same-origin: keep the fixed height */ }
    });
    return frame;
    });
    try {
      const result = await api.get('/api/positions/detail', { ...params(), refresh: force }, { signal: controller.signal });
      draw(result);
    } catch (error) {
      if (error.name === 'AbortError') return;
      clear(kpis).append(errorBox(error, () => load({ force: true })));
      head.querySelector('p').textContent = '';
    }
  }

  function draw(result) {
    const { analysis: a, how, dataNote } = result.data;
    const perf = a.performance;
    const [statusLabel, statusKind] = STATUS[a.status] ?? [a.status, ''];
    clear(head).append(h('div', null,
      h('h1', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, `${a.pair} ${fee(a.feeTier)}`, badge(statusLabel, statusKind), badge(`${a.dex} ${a.protocol}`, 'accent')),
      h('p', null, `${a.chain} · position #${a.id} · ${a.walletName ?? a.wallet} · ${a.unit}${how && !how.startsWith('position') ? ` · ${how}` : ''}`)),
      h('span', { class: 'grow' }),
      h('div', { class: 'toolbar' },
        a.pool && h('button', { class: 'btn sm', onclick: () => ctx.navigate('chart', { pool: a.pool, chain, timeframe: '1h' }) }, icon('chart'), 'Pool chart'),
        a.active ? null : h('button', { class: 'btn sm', onclick: () => ctx.navigate('plan', { pair: `${a.base.symbol}/${a.quote.symbol}`, chain, fee: a.feeTier ? String(a.feeTier / 10_000) : undefined }) }, icon('plan'), 'Plan similar'),
        a.links?.position && external(a.links.position, 'Uniswap'),
        a.links?.explorer && external(a.links.explorer, 'Explorer'),
        copyButton(a.wallet, 'Copy wallet address')));
    clear(notes);
    const banner = notesBanner([...(result.notes ?? []), dataNote && `Chart data: ${dataNote}`].filter(Boolean));
    if (banner) notes.append(banner);
    const p = a.prices;
    clear(kpis).append(
      kpi(a.active ? 'Value' : 'Withdrawn', usd(a.active ? perf.valueUsd : perf.withdrawnUsd), { kind: 'accent', foot: `deposited ${usd(perf.depositedUsd)}` }),
      kpi('PnL', signedUsd(perf.pnlUsd), { tone: tone(perf.pnlUsd), kind: perf.pnlUsd < 0 ? 'bad' : 'good', foot: perf.pnlPct !== undefined ? pct(perf.pnlPct, { sign: true }) : undefined }),
      kpi('Fees earned', usd(perf.feesUsd), { kind: 'good', foot: perf.feesPerDayUsd !== undefined ? `${usd(perf.feesPerDayUsd)} per day` : undefined }),
      kpi('Fee APR', pct(perf.feeAprPct), { foot: `total APR ${pct(perf.totalAprPct)}` }),
      kpi('Impermanent loss', signedUsd(perf.ilUsd), { tone: tone(perf.ilUsd), foot: perf.feesCoverIlPct !== undefined ? `fees cover ${pct(perf.feesCoverIlPct)}` : undefined }),
      kpi('vs. holding', signedUsd(perf.vsHodlUsd), { tone: tone(perf.vsHodlUsd), foot: `hold ${usd(perf.hodlUsd)}` }),
      kpi('Range', `${num(p.lower)} – ${num(p.upper)}`, { foot: `width ${pct(p.widthPct)}${p.current ? ` · now ${num(p.current)}` : ''}` }),
      kpi('Time in range', pct(a.history?.inRangePct), { foot: `${duration((perf.daysHeld ?? 0) * 86_400)} held · ${a.history?.exits ?? 0} exits` }),
      a.active && perf.breakeven ? kpi('Breakeven', num(perf.breakeven), { foot: a.unit }) : kpi('Opened', day(a.openedAt), { foot: a.closedAt ? `closed ${day(a.closedAt)}` : 'still open' }),
    );
    clear(hint).append(cliHint(`defi-tool positions detail '#${a.id}' --chain ${chain}${a.walletName ? ` --wallet ${a.walletName}` : ` --wallet-addr ${a.wallet}`} --output html`));
    // Live price of the pool, in the position's unit, for open positions.
    unsubscribe?.();
    if (a.active && a.pool && !ctx.offline) {
      const key = `${a.chainId}:${a.pool.toLowerCase()}:${a.quote.address.toLowerCase()}`;
      events.watch([key]);
      live.hidden = false;
      live.textContent = 'Live price…';
      const offTick = events.on('ticker', (message) => {
        if (message.key !== key) return;
        const price = message.ticker.price;
        const inside = price >= p.lower && price <= p.upper;
        live.className = `badge ${inside ? 'up' : 'down'}`;
        live.textContent = `Live ${num(price)} · ${inside ? 'in range' : 'out of range'}`;
      });
      const offError = events.on('ticker-error', (message) => { if (message.key === key) { live.className = 'badge warn'; live.textContent = 'Live price unavailable'; live.title = message.message; } });
      unsubscribe = () => { offTick(); offError(); };
    }
  }

  // Auto-refresh would reload the report frame and lose its zoom and scroll; the live price updates on its own, and the
  // refresh button (or r) rebuilds the report.
  ctx.onRefresh(({ force } = {}) => force ? load({ force: true }) : undefined);
  await load();
  return () => { controller?.abort(); unsubscribe?.(); stopFrame?.(); };
}

import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { num, pct, usd, tone, chainName } from '../format.js';
import { cliHint, segmented, errorBox, notesBanner, toast } from '../ui.js';
import { state, update } from '../state.js';
import { mountFrame } from './common.js';
import { events } from '../events.js';

// A pool's chart: the dex-data show workspace (candles, indicators, drawing tools) in a frame, with the live ticker.
// Candles come from the dex-data cache first; missing stretches are downloaded into it, as dex-data show does.

export async function render(root, ctx) {
  root.className = 'view full';
  const params = { ...ctx.params };
  params.timeframe ??= '1h';
  if (!params.pair && !params.pool) { ctx.navigate('markets'); return; }
  const live = h('div', { class: 'split' }, h('span', { class: 'skeleton', style: { height: '20px', width: '220px' } }));
  const notes = h('div', { style: { padding: '0 16px' } });
  const frameWrap = h('div', { style: { position: 'relative', flex: '1', minHeight: '0' } });
  const hint = h('div', { style: { padding: '10px 16px' } });
  const timeframes = ctx.meta.timeframes.filter((tf) => tf !== '1m');
  const bar = h('div', { class: 'toolbar', style: { padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--surface)' } },
    h('button', { class: 'btn ghost sm', onclick: () => history.length > 1 ? history.back() : ctx.navigate('markets') }, icon('back')),
    live, h('span', { class: 'grow' }),
    segmented(timeframes.map((tf) => [tf, tf]), params.timeframe, (next) => { params.timeframe = next; ctx.replaceParams(params); load(); }, { label: 'Load candles of' }),
    h('button', { class: 'btn sm', title: 'Add to the watchlist', onclick: () => { update('watchlist', [...state.watchlist, { pair: params.pair, pool: params.pool, chain: params.chain, fee: params.fee, dex: params.dex, protocol: params.protocol, quote: params.quote }]); toast('Added to the Markets watchlist.', { kind: 'ok' }); } }, icon('eye'), 'Watch'),
    h('a', { class: 'btn sm', id: 'chart-tab', target: '_blank', rel: 'noopener' }, icon('external'), 'New tab'));
  root.append(h('div', { style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--top))' } }, bar, notes, frameWrap, hint));

  let controller;
  let offTicker;
  let stopFrame;
  async function load({ force = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
    if (force) query.set('refresh', '1');
    root.querySelector('#chart-tab').href = `/report/chart?${query}`;
    clear(frameWrap).append(h('div', { class: 'loading', style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: 'var(--muted)' } },
      h('div', { style: { display: 'grid', gap: '10px', justifyItems: 'center' } }, h('div', { class: 'progress', style: { width: '200px' } }, h('div')), 'Reading the cache and downloading missing candles…')));
    stopFrame?.();
    stopFrame = mountFrame(frameWrap, () => {
      const frame = h('iframe', { class: 'frame', title: 'Pool chart', style: { position: 'absolute', inset: '0', height: '100%' }, src: `/report/chart?${query}` });
      frame.addEventListener('load', () => frameWrap.querySelector('.loading')?.remove());
      return frame;
    });
    clear(hint).append(cliHint(`defi-tool dex-data show ${params.pair ?? `--pool ${params.pool}`} --chain ${params.chain ?? ''}${params.fee ? ` --fee ${params.fee}` : ''}${params.dex ? ` --dex ${params.dex}` : ''}${params.protocol ? ` --protocol ${params.protocol}` : ''} --timeframe ${params.timeframe} --output html`.replace(/\s+/g, ' ')));
    try {
      const result = await api.get('/api/pools/chart', { ...params, refresh: force }, { signal: controller.signal });
      clear(notes);
      const banner = notesBanner([...(result.notes ?? []), result.data.tickerNote && `Live price: ${result.data.tickerNote}`].filter(Boolean));
      if (banner) notes.append(h('div', { style: { padding: '10px 0' } }, banner));
      const data = result.data;
      const label = `${data.pool.dex ?? ''} ${data.pool.version ?? ''} ${data.pool.feeTier ? `${data.pool.feeTier / 10_000}%` : ''} · ${chainName(ctx.meta, data.pool.chainId)}`;
      const drawLive = (ticker) => {
        clear(live).append(h('b', { style: { fontSize: '16px' } }, data.pair), h('span', { class: 'muted' }, label),
          ticker ? [h('b', { class: 'num', style: { fontSize: '16px' } }, num(ticker.price)), h('span', { class: `badge ${tone(ticker.change24hPct)}` }, pct(ticker.change24hPct, { sign: true })),
            h('span', { class: 'muted hide-sm' }, `H ${num(ticker.high24h)} · L ${num(ticker.low24h)} · Vol ${usd(ticker.volume24hUsd)} · Liq ${usd(ticker.liquidityUsd)}`)] : h('span', { class: 'muted' }, 'live price unavailable'));
      };
      drawLive(data.ticker);
      offTicker?.();
      if (!ctx.offline) {
        events.watch([data.tickerKey]);
        offTicker = events.on('ticker', (message) => { if (message.key === data.tickerKey) drawLive(message.ticker); });
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      clear(live);
      clear(notes).append(h('div', { style: { padding: '10px 0' } }, errorBox(error, () => load({ force: true }))));
    }
  }
  ctx.onRefresh(({ force } = {}) => force ? load({ force: true }) : undefined);
  await load();
  return () => { controller?.abort(); offTicker?.(); stopFrame?.(); };
}

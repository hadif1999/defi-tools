import { h, icon, clear, cssVar } from '../dom.js';
import { api } from '../api.js';
import { num, pct, usd, compact, tone, ago, chainName } from '../format.js';
import { card, cliHint, field, input, select, segmented, toast, emptyState, errorBox, sparkline, notesBanner, seriesColor } from '../ui.js';
import { state, update, onChange, persist } from '../state.js';
import { events } from '../events.js';
import { chartLibrary } from './charts.js';

// Markets: a watchlist of live DEX pool tickers (dex-ticker --watch, streamed by the server) and market prices blended
// across venues (market-data), charted as prices or as % change to compare coins.

export async function render(root, ctx) {
  const grid = h('div', { class: 'ticker-grid' });
  const addPair = input({ placeholder: 'WETH/USDC', 'aria-label': 'Pair', style: { width: '140px', height: '30px' } });
  const addChain = select(ctx.meta.chains.map((chain) => [chain.slug, chain.name]), { value: 'base', 'aria-label': 'Network', style: { width: '140px', height: '30px' } });
  const addFee = input({ placeholder: 'fee %', style: { width: '76px', height: '30px' }, 'aria-label': 'Fee tier' });
  const addForm = h('form', { class: 'split', onsubmit: (event) => {
    event.preventDefault();
    const pair = addPair.value.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(pair)) { toast('Enter a pair such as WETH/USDC.', { kind: 'error' }); addPair.focus(); return; }
    const entry = { pair, chain: addChain.value, fee: addFee.value.trim() || undefined };
    if (entry.chain === 'solana') Object.assign(entry, { dex: 'raydium', protocol: 'clmm' });
    update('watchlist', [...state.watchlist, entry]);
    addPair.value = ''; addFee.value = '';
  } }, addPair, addChain, addFee, h('button', { class: 'btn sm primary', type: 'submit' }, icon('plus'), 'Watch'));
  const watchNotes = h('div');

  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Markets'), h('p', null, 'Live pool prices from GeckoTerminal and blended market prices from DefiLlama. No keys.'))),
    card('Watchlist', h('div', { style: { display: 'grid', gap: '12px' } }, watchNotes, grid), { sub: ctx.offline ? 'offline: live prices are off' : 'live · updates every 15–60 s', actions: addForm }));

  // ---------- watchlist
  const cards = new Map();
  const history = new Map();
  let keys = [];
  const describe = (entry) => `${entry.pair ?? entry.label ?? entry.pool?.slice(0, 10)} · ${chainName(ctx.meta, entry.chain)}${entry.fee ? ` · ${entry.fee}%` : ''}`;

  async function resolveWatchlist() {
    clear(grid);
    cards.clear();
    if (!state.watchlist.length) { grid.append(emptyState('Nothing watched', 'Add a pair above, or the eye button on the Pools page.', { iconName: 'eye' })); events.watch([]); return; }
    const resolved = await Promise.all(state.watchlist.map(async (entry, index) => {
      const node = h('div', { class: 'tick' }, h('div', { class: 'head' }, h('b', null, entry.label ?? entry.pair ?? 'Pool'), h('span', { class: 'muted', style: { fontSize: '12px' } }, describe(entry))), h('span', { class: 'skeleton', style: { height: '28px', width: '60%' } }));
      grid.append(node);
      try {
        const result = await api.get('/api/ticker', { pair: entry.pair, pool: entry.pool, chain: entry.chain, fee: entry.fee, dex: entry.dex, protocol: entry.protocol, quote: entry.quote });
        cards.set(result.data.key, { node, entry, index });
        // Remember the pool, so the next visit looks it up directly instead of searching for the pair again.
        if (!entry.pool) { entry.pool = result.data.ticker.pool.address; entry.label ??= entry.pair; delete entry.pair; delete entry.fee; persist('watchlist'); }
        drawTick(result.data.key, result.data.ticker);
        return result.data.key;
      } catch (error) {
        clear(node).append(h('div', { class: 'head' }, h('b', null, entry.label ?? entry.pair ?? 'Pool'), h('span', { class: 'grow' }), removeButton(index)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, error.message));
        return undefined;
      }
    }));
    keys = resolved.filter(Boolean);
    events.watch(keys);
  }
  const removeButton = (index) => h('button', { class: 'btn ghost sm icon', title: 'Remove', 'aria-label': 'Remove from watchlist', onclick: () => update('watchlist', state.watchlist.filter((_, i) => i !== index)) }, icon('close'));

  function drawTick(key, ticker, previous) {
    const slot = cards.get(key);
    if (!slot) return;
    const series = history.get(key) ?? [];
    if (series.at(-1)?.at !== ticker.updatedAt) series.push({ at: ticker.updatedAt, price: ticker.price });
    history.set(key, series.slice(-120));
    const { node, entry, index } = slot;
    const change = ticker.change24hPct;
    clear(node).append(
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost sm icon', title: 'Open chart', 'aria-label': 'Open chart', onclick: () => ctx.navigate('chart', { pool: ticker.pool.address, chain: ticker.chain, quote: entry.quote, timeframe: '1h' }) }, icon('chart')), removeButton(index)),
      h('div', { class: 'head' }, h('b', null, ticker.pair), h('span', { class: 'muted', style: { fontSize: '12px' } }, `${ticker.pool.dex ?? ticker.pool.dexId} ${ticker.pool.version ?? ''} ${ticker.pool.feeTier ? `${ticker.pool.feeTier / 10_000}%` : ''} · ${chainName(ctx.meta, ticker.chainId)}`)),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } }, h('span', { class: 'price' }, num(ticker.price)), h('span', { class: `badge ${tone(change)}` }, pct(change, { sign: true })), h('span', { class: 'grow', style: { flex: 1 } }), sparkline(history.get(key).map((point) => point.price), { width: 80, height: 26 })),
      h('div', { class: 'muted', style: { fontSize: '11.5px' } }, ticker.priceUnit),
      h('div', { class: 'stats' }, h('div', null, '24h high', h('b', null, num(ticker.high24h))), h('div', null, '24h low', h('b', null, num(ticker.low24h))), h('div', null, 'Volume', h('b', null, usd(ticker.volume24hUsd))),
        h('div', null, 'Liquidity', h('b', null, usd(ticker.liquidityUsd))), h('div', null, 'Trades', h('b', null, compact(ticker.trades24h))), h('div', null, 'Updated', h('b', { dataset: { at: ticker.updatedAt }, class: 'ago' }, ago(ticker.updatedAt)))),
    );
    if (previous !== undefined && previous !== ticker.price) {
      node.classList.remove('flash-up', 'flash-down');
      void node.offsetWidth;
      node.classList.add(ticker.price > previous ? 'flash-up' : 'flash-down');
      setTimeout(() => node.classList.remove('flash-up', 'flash-down'), 1500);
    }
  }
  const last = new Map();
  const offTicker = events.on('ticker', ({ key, ticker }) => { drawTick(key, ticker, last.get(key)); last.set(key, ticker.price); });
  const offError = events.on('ticker-error', ({ key, message }) => {
    const slot = cards.get(key);
    if (slot) slot.node.title = `Last update failed: ${message}`;
  });
  const agoTimer = setInterval(() => { for (const node of grid.querySelectorAll('.ago')) node.textContent = ago(node.dataset.at); }, 5000);
  const offState = onChange((key) => { if (key === 'watchlist') void resolveWatchlist(); });

  // ---------- market prices
  const pairs = input({ value: state.marketPairs, placeholder: 'ETH,BTC,SOL or BTC/ETH', 'aria-label': 'Coins or pairs', style: { width: '200px', height: '30px' } });
  let timeframe = '1h';
  let from = '30d';
  let modeValue = 'change';
  const chartBox = h('div', { class: 'chart-box' });
  const legendNode = h('div', { class: 'chart-legend' });
  const marketNotes = h('div');
  const hint = h('div');
  const marketForm = h('form', { class: 'split', onsubmit: (event) => { event.preventDefault(); update('marketPairs', pairs.value.trim()); void drawMarket(); } },
    pairs, segmented([['7d', '7D'], ['30d', '1M'], ['90d', '3M'], ['365d', '1Y']], from, (next) => { from = next; timeframe = { '7d': '1h', '30d': '1h', '90d': '4h', '365d': '1d' }[next]; void drawMarket(); }, { label: 'Range' }),
    segmented([['change', '% change'], ['price', 'Price']], modeValue, (next) => { modeValue = next; void drawMarket(); }, { label: 'Scale' }),
    h('button', { class: 'btn sm primary', type: 'submit' }, 'Chart'));
  root.append(card('Market prices', h('div', { style: { display: 'grid', gap: '10px' } }, marketNotes, h('div', { style: { position: 'relative' } }, legendNode, chartBox)), { sub: 'DefiLlama blended USD prices; pairs are cross rates', actions: marketForm }), hint);

  let chart;
  let controller;
  async function drawMarket({ force = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    clear(marketNotes);
    clear(legendNode);
    const text = pairs.value.trim();
    clear(hint).append(cliHint(`defi-tool market-data download ${text} --timeframe ${timeframe} --from ${from}`));
    if (!text) return;
    let result;
    let library;
    try {
      [result, library] = await Promise.all([api.get('/api/market', { pairs: text, timeframe, from, refresh: force }, { signal: controller.signal }), chartLibrary()]);
    } catch (error) {
      if (error.name !== 'AbortError') marketNotes.append(errorBox(error, () => drawMarket({ force: true })));
      return;
    }
    const errors = result.data.series.filter((series) => series.error).map((series) => `${series.label}: ${series.error}`);
    const banner = notesBanner(errors, { kind: 'error' });
    if (banner) marketNotes.append(banner);
    chart?.remove();
    chart = library.createChart(chartBox, {
      autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: cssVar('--line-2') }, horzLines: { color: cssVar('--line-2') } }, rightPriceScale: { borderColor: cssVar('--line') },
      timeScale: { borderColor: cssVar('--line'), timeVisible: true }, crosshair: { mode: 0 },
      localization: { priceFormatter: (value) => modeValue === 'change' ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : num(value) },
    });
    const valid = result.data.series.filter((series) => series.candles?.length);
    valid.forEach((series, index) => {
      const color = getComputedStyle(document.documentElement).getPropertyValue(seriesColor(index).slice(4, -1)).trim();
      const first = series.candles.find((candle) => !candle[6])?.[4] ?? series.candles[0][4];
      const line = chart.addSeries(library.LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      line.setData(series.candles.map((candle) => ({ time: candle[0], value: modeValue === 'change' ? (candle[4] / first - 1) * 100 : candle[4] })));
      const lastClose = series.candles.at(-1)[4];
      const change = (lastClose / first - 1) * 100;
      legendNode.append(h('span', { class: 'item' }, h('span', { class: 'swatch', style: { background: color } }), h('b', null, series.label), num(lastClose), h('span', { class: tone(change) }, pct(change, { sign: true })),
        h('span', { class: 'muted' }, series.dataset?.priceUnit ?? '')));
    });
    if (!valid.length && !errors.length) marketNotes.append(emptyState('No prices', 'DefiLlama returned no samples for that range.'));
    chart.timeScale().fitContent();
  }

  ctx.onRefresh(({ force } = {}) => drawMarket({ force }));
  await Promise.all([resolveWatchlist(), drawMarket()]);
  return () => { offTicker(); offError(); offState(); clearInterval(agoTimer); controller?.abort(); chart?.remove(); };
}

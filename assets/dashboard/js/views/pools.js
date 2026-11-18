import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, pct, count, age, fee, ago, MISSING } from '../format.js';
import { card, dataTable, emptyState, cliHint, field, input, select, segmented, toast, badge, pairCell } from '../ui.js';
import { chainParam, formValues, rememberForm, state, update } from '../state.js';
import { loader } from './common.js';

// Pools: pools scan / get / rank with every option the CLI has: networks, pool types, exchanges, sort keys, top, minimum
// TVL, token, the --filter builder and the data source. Rows open the pool chart, join the watchlist, or plan a position.

const OPS = ['>', '>=', '<', '<=', '=', '!='];

function checks(name, options, selected, onChange) {
  const node = h('div', { class: 'split', role: 'group', 'aria-label': name });
  const draw = () => {
    clear(node);
    for (const [value, label] of options) {
      node.append(h('label', { class: 'chip', style: { cursor: 'pointer', background: selected.has(value) ? 'var(--accent-soft)' : undefined, color: selected.has(value) ? 'var(--accent)' : undefined } },
        h('input', { type: 'checkbox', checked: selected.has(value), style: { display: 'none' }, onchange: (event) => { if (event.target.checked) selected.add(value); else selected.delete(value); draw(); onChange?.(); } }), label));
    }
  };
  draw();
  return node;
}

export async function render(root, ctx) {
  const meta = ctx.meta;
  const saved = formValues('pools', { mode: 'scan', pair: '', chain: '', protocol: [], dex: [], sort: 'tvl', top: '25', minTvl: '', token: '', filters: [], source: 'public' });
  const values = { ...saved, ...Object.fromEntries(Object.entries(ctx.params).filter(([key]) => key in saved && key !== 'filters' && key !== 'protocol' && key !== 'dex')) };
  if (ctx.params.pair && !ctx.params.mode) values.mode = 'get';
  const protocols = new Set(values.protocol);
  const dexes = new Set(values.dex);
  let filters = Array.isArray(values.filters) ? values.filters : [];
  let mode = values.mode;

  const pair = input({ value: values.pair, placeholder: 'WSOL/USDC', name: 'pair' });
  const chain = input({ value: values.chain, placeholder: chainParam() ?? 'saved networks (or all for get)', name: 'chain' });
  const sort = input({ value: values.sort, placeholder: 'tvl,apr', name: 'sort', list: 'sort-keys' });
  const top = input({ value: values.top, type: 'number', min: 1, max: 200, name: 'top' });
  const minTvl = input({ value: values.minTvl, placeholder: '250k', name: 'minTvl' });
  const token = input({ value: values.token, placeholder: 'USDC or 0x…', name: 'token' });
  const source = select([['public', 'DefiLlama (default)'], ['geckoterminal', 'GeckoTerminal'], ['custom', 'Custom GraphQL']], { value: values.source, name: 'source' });
  const pairField = field('Pair', pair, { hint: 'Either token order; ETH matches WETH' });
  const filterList = h('div', { class: 'split' });
  const results = h('div');
  const notes = h('div');
  const stamp = h('span', { class: 'muted', style: { fontSize: '12px' } });
  const hint = h('div');

  const drawFilters = () => {
    clear(filterList);
    filters.forEach((text, index) => filterList.append(h('span', { class: 'chip mono' }, text, h('button', { 'aria-label': `Remove filter ${text}`, onclick: () => { filters = filters.filter((_, i) => i !== index); drawFilters(); } }, icon('close')))));
    const column = select(meta.filterColumns, { style: { height: '30px', width: '110px' }, 'aria-label': 'Filter column' });
    const op = select(OPS, { style: { height: '30px', width: '64px' }, 'aria-label': 'Operator' });
    const value = input({ placeholder: '10, 1m, 6m', style: { height: '30px', width: '110px' }, 'aria-label': 'Filter value' });
    const add = () => {
      if (!value.value.trim()) { value.focus(); return; }
      filters = [...filters, `${column.value}${op.value}${value.value.trim()}`];
      drawFilters();
    };
    value.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
    filterList.append(h('span', { class: 'split' }, column, op, value, h('button', { class: 'btn sm', type: 'button', onclick: add }, icon('plus'), 'Filter')));
  };
  drawFilters();

  const modeControl = segmented([['scan', 'Scan'], ['get', 'Pair'], ['rank', 'Rank']], mode, (next) => { mode = next; pairField.hidden = mode !== 'get'; sort.disabled = mode === 'rank'; }, { label: 'Mode' });
  pairField.hidden = mode !== 'get';
  sort.disabled = mode === 'rank';

  const form = h('form', { class: 'card', onsubmit: (event) => { event.preventDefault(); search(); } },
    h('header', null, h('h2', null, 'Find pools'), modeControl, h('span', { class: 'grow' }), h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Search')),
    h('div', { class: 'body', style: { display: 'grid', gap: '14px' } },
      h('div', { class: 'form-grid' }, pairField, field('Networks', chain, { hint: 'eth,base,arb… or all' }), field('Sort', sort, { hint: meta.poolSorts.join(', ') }), field('Top', top),
        field('Min TVL', minTvl), field('Token', token), field('Source', source)),
      h('datalist', { id: 'sort-keys' }, meta.poolSorts.map((key) => h('option', { value: key }))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Pool types (none = all)'), checks('Pool types', meta.poolVersions.map((version) => [version, version.toUpperCase()]), protocols)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Exchanges (none = all)'), checks('Exchanges', meta.dexes.map((dex) => [dex, dex[0].toUpperCase() + dex.slice(1)]), dexes)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Filters (all must hold)'), filterList)));

  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Pools'), h('p', null, 'Uniswap, PancakeSwap, Aerodrome and Curve on EVM networks, Raydium on Solana. Same data and rules as defi-tool pools.'))), form, notes,
    card('Results', results, { flush: true, actions: stamp }), hint);

  const current = () => ({
    mode, pair: mode === 'get' ? pair.value.trim() : undefined, chain: chain.value.trim() || (mode === 'get' ? undefined : chainParam()), protocol: [...protocols].join(',') || undefined, dex: [...dexes].join(',') || undefined,
    sort: mode === 'rank' ? undefined : sort.value.trim() || undefined, top: top.value.trim() || undefined, minTvl: minTvl.value.trim() || undefined, token: token.value.trim() || undefined,
    source: source.value === 'public' ? undefined : source.value, filter: filters,
  });

  const cliFor = (query) => {
    const parts = ['defi-tool pools', query.mode];
    if (query.mode === 'get') parts.push(query.pair);
    if (query.chain) parts.push(`--chain ${query.chain}`);
    if (query.protocol) parts.push(`--protocol ${query.protocol}`);
    if (query.dex) parts.push(`--dex ${query.dex}`);
    if (query.sort && query.sort !== 'tvl') parts.push(`--sort ${query.sort}`);
    if (query.top && query.top !== '25') parts.push(`--top ${query.top}`);
    if (query.minTvl) parts.push(`--min-tvl ${query.minTvl}`);
    if (query.token) parts.push(`--token ${query.token}`);
    for (const filter of query.filter) parts.push(`--filter "${filter}"`);
    if (query.source) parts.push(`--source ${query.source}`);
    return parts.join(' ');
  };

  let query = current();
  const chainSlug = (id) => meta.chains.find((item) => item.id === id)?.slug ?? id;
  const columns = () => [
    { key: 'pool', label: 'Pool', sort: (row) => row.pool.name ?? `${row.pool.token0.symbol}/${row.pool.token1.symbol}`, render: (row) => pairCell((row.pool.tokens ?? [row.pool.token0, row.pool.token1]).map((token) => token.symbol), row.pool.address ? `${row.pool.address.slice(0, 10)}…` : undefined) },
    { key: 'chain', label: 'Chain', sort: (row) => chainSlug(row.pool.chainId), render: (row) => meta.chains.find((item) => item.id === row.pool.chainId)?.name ?? row.pool.chainId },
    { key: 'dex', label: 'DEX', sort: (row) => row.pool.dex ?? 'Uniswap', render: (row) => row.pool.dex ?? 'Uniswap' },
    { key: 'version', label: 'Version', sort: (row) => row.pool.protocol, render: (row) => badge(row.pool.protocol.toUpperCase(), 'accent') },
    { key: 'fee', label: 'Fee', align: 'right', sort: (row) => row.pool.feeTier, render: (row) => row.pool.feeLabel ?? fee(row.pool.feeTier) },
    { key: 'tvl', label: 'TVL', align: 'right', sort: (row) => row.pool.tvlUsd, render: (row) => h('b', null, usd(row.pool.tvlUsd)) },
    { key: 'vol', label: '1D vol', align: 'right', sort: (row) => row.pool.volume24hUsd, render: (row) => usd(row.pool.volume24hUsd) },
    { key: 'vol7', label: '7D vol', align: 'right', sort: (row) => row.pool.volume7dUsd, render: (row) => usd(row.pool.volume7dUsd) },
    { key: 'voltvl', label: 'Vol/TVL', align: 'right', sort: (row) => row.pool.tvlUsd ? (row.pool.volume24hUsd ?? NaN) / row.pool.tvlUsd : undefined, render: (row) => row.pool.tvlUsd && row.pool.volume24hUsd !== undefined ? (row.pool.volume24hUsd / row.pool.tvlUsd < 0.01 ? '<0.01' : (row.pool.volume24hUsd / row.pool.tvlUsd).toFixed(2)) : MISSING },
    { key: 'apr', label: 'APR', align: 'right', sort: (row) => row.pool.aprPct, render: (row) => h('span', { class: row.pool.aprPct > 20 ? 'up' : '' }, pct(row.pool.aprPct)) },
    { key: 'txns', label: '1D txns', align: 'right', sort: (row) => row.pool.txCount24h, render: (row) => count(row.pool.txCount24h) },
    { key: 'age', label: 'Age', align: 'right', sort: (row) => row.pool.createdAt ? -Date.parse(row.pool.createdAt) : undefined, render: (row) => age(row.pool.createdAt), csv: (row) => row.pool.createdAt },
    ...(query.mode === 'rank' ? [
      { key: 'score', label: 'Score', align: 'right', sort: (row) => row.score, render: (row) => h('b', null, row.score.toFixed(1)) },
      { key: 'confidence', label: 'Confidence', align: 'right', sort: (row) => row.confidence, render: (row) => badge(pct(row.confidence * 100, { digits: 0 }), row.confidence >= 0.7 ? 'up' : row.confidence >= 0.4 ? 'warn' : 'down') },
      { key: 'reasons', label: 'Why', wrap: true, render: (row) => h('span', { class: 'muted', style: { fontSize: '12px' } }, row.reasons.slice(0, 2).join('; ')), csv: (row) => row.reasons.join('; ') },
    ] : []),
    { key: 'actions', label: '', render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap' } },
      h('button', { class: 'btn sm icon', title: 'Pool chart', 'aria-label': 'Pool chart', onclick: () => openChart(row.pool) }, icon('chart')),
      h('button', { class: 'btn sm icon', title: 'Add to the markets watchlist', 'aria-label': 'Watch', onclick: () => watch(row.pool) }, icon('eye')),
      canPlan(row.pool) && h('button', { class: 'btn sm icon', title: 'Plan a position', 'aria-label': 'Plan a position', onclick: () => ctx.navigate('plan', { pool: row.pool.address, chain: chainSlug(row.pool.chainId) }) }, icon('plan'))) },
  ];
  const choiceOf = (pool) => pool.address
    ? { pool: pool.address, chain: chainSlug(pool.chainId) }
    : { pair: `${pool.token0.symbol}/${pool.token1.symbol}`, chain: chainSlug(pool.chainId), fee: pool.feeTier ? String(pool.feeTier / 10_000) : undefined, dex: (pool.dex ?? 'uniswap').toLowerCase(), protocol: pool.protocol };
  const openChart = (pool) => ctx.navigate('chart', { ...choiceOf(pool), timeframe: '1h' });
  const watch = (pool) => {
    const entry = { ...choiceOf(pool), label: `${pool.token0.symbol}/${pool.token1.symbol}` };
    if (state.watchlist.some((item) => JSON.stringify({ ...item, label: undefined }) === JSON.stringify({ ...entry, label: undefined }))) { toast('Already on the watchlist.'); return; }
    update('watchlist', [...state.watchlist, entry]);
    toast(`${entry.label} added to the Markets watchlist.`, { kind: 'ok' });
  };
  const canPlan = (pool) => pool.address && pool.protocol === 'v3' && (pool.dex ?? 'Uniswap') === 'Uniswap' && meta.createChains.includes(chainSlug(pool.chainId));

  const load = loader(results, ({ signal, refresh }) => api.get('/api/pools', { ...query, refresh }, { signal }), (result) => {
    stamp.textContent = `${result.data.sourceName} · ${result.data.chains.join(', ')} · ${result.cached ? 'cached' : 'updated'} ${ago(result.cachedAt)}`;
    results.append(dataTable({
      name: `pools-${query.mode}`, rows: result.data.items, columns: columns(), pageSize: 50, exportName: `pools-${query.mode}`,
      search: (row) => `${row.pool.token0.symbol} ${row.pool.token1.symbol} ${row.pool.dex ?? 'uniswap'} ${row.pool.address ?? ''}`,
      onRow: (row) => openChart(row.pool),
      empty: emptyState('No pools match', 'Loosen the filters, add networks, or try another source.', { iconName: 'pools' }),
    }));
  }, { rows: 8, notesSlot: notes });

  function search() {
    query = current();
    if (query.mode === 'get' && !query.pair) { pairField.setError('Name a pair, e.g. WSOL/USDC.'); pair.focus(); return; }
    pairField.setError();
    rememberForm('pools', { mode, pair: pair.value, chain: chain.value, protocol: [...protocols], dex: [...dexes], sort: sort.value, top: top.value, minTvl: minTvl.value, token: token.value, filters, source: source.value });
    clear(hint).append(cliHint(cliFor(query)));
    void load();
  }
  ctx.onRefresh(({ force } = {}) => load({ quiet: true, force }));
  search();
  return () => load.abort();
}

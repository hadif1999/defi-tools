import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { count, time, compact, chainName, fee } from '../format.js';
import { card, dataTable, emptyState, cliHint, field, input, select, badge, toast, segmented } from '../ui.js';
import { formValues, rememberForm } from '../state.js';
import { events } from '../events.js';
import { loader } from './common.js';

// Data: dex-data download and market-data download as background jobs with live progress, and the files they saved
// (the same folders the CLI and the charts use), with their checks, to chart or download.

export async function render(root, ctx) {
  const meta = ctx.meta;
  let kind = ctx.params.kind ?? 'dex';
  const jobs = h('div', { style: { display: 'grid', gap: '10px' } });
  const files = h('div');
  const formSlot = h('div');
  const hint = h('div');
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Data'), h('p', null, `Candles saved in ${meta.dashboard.dataDir} (pools) and ${meta.dashboard.marketDir} (market prices). Pool charts and position reports read the pool cache first.`))),
    h('div', { class: 'grid side-r' }, h('div', { class: 'grid' }, formSlot, hint), card('Jobs', jobs, { sub: 'this session' })),
    card('Saved files', files, { flush: true }));

  // ---------- forms
  function dexForm() {
    const values = formValues('dex-download', { pairs: 'WETH/USDC', pool: '', chain: 'base', dex: 'uniswap', protocol: 'v3', fee: '', timeframe: '1h', from: '30d', to: 'now', format: 'csv', quote: 'auto', fill: 'forward' });
    const controls = {
      pairs: input({ value: values.pairs, placeholder: 'WETH/USDC,cbBTC/USDC' }), pool: input({ value: values.pool, placeholder: '0x… instead of pairs' }), chain: input({ value: values.chain, placeholder: 'base or eth,arb' }),
      dex: input({ value: values.dex }), protocol: input({ value: values.protocol }), fee: input({ value: values.fee, placeholder: 'any' }),
      timeframe: select(meta.timeframes, { value: values.timeframe }), from: input({ value: values.from, placeholder: '30d, 2026-10-01' }), to: input({ value: values.to }),
      format: select(meta.candleFormats, { value: values.format }), quote: input({ value: values.quote, placeholder: 'auto, usd or a token' }), fill: select(meta.fillModes, { value: values.fill }),
    };
    const force = h('input', { type: 'checkbox' });
    const partial = h('input', { type: 'checkbox' });
    const body = () => ({ ...Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value.trim() || undefined])), force: force.checked || undefined, includePartial: partial.checked || undefined });
    const cli = (b) => `defi-tool dex-data download ${b.pairs ?? `--pool ${b.pool}`}${b.chain ? ` --chain ${b.chain}` : ''}${b.dex && b.dex !== 'uniswap' ? ` --dex ${b.dex}` : ''}${b.protocol && b.protocol !== 'v3' ? ` --protocol ${b.protocol}` : ''}${b.fee ? ` --fee ${b.fee}` : ''} --timeframe ${b.timeframe} --from ${b.from} --to ${b.to} --format ${b.format}${b.quote !== 'auto' ? ` --quote ${b.quote}` : ''}${b.fill !== 'forward' ? ` --fill ${b.fill}` : ''}${b.force ? ' --force' : ''}${b.includePartial ? ' --include-partial' : ''} --out-dir ${meta.dashboard.dataDir}`;
    const submit = (dryRun) => async (event) => {
      event?.preventDefault();
      const b = body();
      rememberForm('dex-download', { ...values, ...Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])) });
      clear(hint).append(cliHint(`${cli(b)}${dryRun ? ' --dry-run' : ''}`));
      await start('/api/downloads/dex', { ...b, dryRun: dryRun || undefined });
    };
    clear(hint).append(cliHint(cli(body())));
    return h('form', { class: 'card', onsubmit: submit(false) },
      h('header', null, h('h2', null, 'Download pool candles'), h('span', { class: 'sub' }, 'GeckoTerminal · last 180 days'), h('span', { class: 'grow' }),
        h('button', { class: 'btn', type: 'button', onclick: submit(true) }, 'Dry run'), h('button', { class: 'btn primary', type: 'submit', disabled: ctx.readOnly || ctx.offline }, icon('download'), 'Download')),
      h('div', { class: 'body', style: { display: 'grid', gap: '12px' } }, h('div', { class: 'form-grid' },
        field('Pairs', controls.pairs), field('…or pools', controls.pool), field('Networks', controls.chain), field('Exchanges', controls.dex, { hint: meta.dexes.join(', ') }), field('Pool types', controls.protocol), field('Fee %', controls.fee),
        field('Timeframe', controls.timeframe), field('From', controls.from), field('To', controls.to), field('Format', controls.format), field('Quote', controls.quote), field('Gaps', controls.fill)),
        h('div', { class: 'toolbar' }, h('label', { class: 'check' }, force, 'Replace existing files'), h('label', { class: 'check' }, partial, 'Keep the unfinished candle'))));
  }

  function marketForm() {
    const values = formValues('market-download', { pairs: 'ETH,BTC/ETH', timeframe: '1h', sample: 'auto', from: '30d', to: 'now', format: 'csv', fill: 'forward' });
    const controls = {
      pairs: input({ value: values.pairs, placeholder: 'ETH,BTC/ETH,coingecko:aerodrome-finance' }), timeframe: select(meta.marketTimeframes, { value: values.timeframe }), sample: select(['auto', ...meta.samplePeriods], { value: values.sample }),
      from: input({ value: values.from }), to: input({ value: values.to }), format: select(meta.candleFormats, { value: values.format }), fill: select(meta.fillModes, { value: values.fill }),
    };
    const force = h('input', { type: 'checkbox' });
    const body = () => ({ ...Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value.trim() || undefined])), force: force.checked || undefined });
    const cli = (b) => `defi-tool market-data download ${b.pairs} --timeframe ${b.timeframe}${b.sample !== 'auto' ? ` --sample ${b.sample}` : ''} --from ${b.from} --to ${b.to} --format ${b.format}${b.fill !== 'forward' ? ` --fill ${b.fill}` : ''}${b.force ? ' --force' : ''} --out-dir ${meta.dashboard.marketDir}`;
    const submit = (dryRun) => async (event) => {
      event?.preventDefault();
      const b = body();
      if (!b.pairs) { toast('Name one or more coins or pairs, e.g. ETH,BTC/ETH.', { kind: 'error' }); return; }
      rememberForm('market-download', Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])));
      clear(hint).append(cliHint(`${cli(b)}${dryRun ? ' --dry-run' : ''}`));
      await start('/api/downloads/market', { ...b, dryRun: dryRun || undefined });
    };
    clear(hint).append(cliHint(cli(body())));
    return h('form', { class: 'card', onsubmit: submit(false) },
      h('header', null, h('h2', null, 'Download market prices'), h('span', { class: 'sub' }, 'DefiLlama · blended across venues'), h('span', { class: 'grow' }),
        h('button', { class: 'btn', type: 'button', onclick: submit(true) }, 'Dry run'), h('button', { class: 'btn primary', type: 'submit', disabled: ctx.readOnly || ctx.offline }, icon('download'), 'Download')),
      h('div', { class: 'body', style: { display: 'grid', gap: '12px' } }, h('div', { class: 'form-grid' },
        field('Coins or pairs', controls.pairs), field('Timeframe', controls.timeframe), field('Sample', controls.sample), field('From', controls.from), field('To', controls.to), field('Format', controls.format), field('Gaps', controls.fill)),
        h('label', { class: 'check' }, force, 'Replace existing files')));
  }

  const drawForm = () => {
    clear(formSlot).append(h('div', { class: 'toolbar' }, segmented([['dex', 'Pool candles'], ['market', 'Market prices']], kind, (next) => { kind = next; ctx.replaceParams({ kind }); drawForm(); }, { label: 'Kind' })), kind === 'dex' ? dexForm() : marketForm());
  };
  drawForm();

  // ---------- jobs
  const shown = new Map();
  function jobCard(job) {
    const node = shown.get(job.id) ?? h('div', { class: 'job' });
    shown.set(job.id, node);
    clear(node).append(h('div', { class: 'head' }, badge(job.status, job.status === 'done' ? 'up' : job.status === 'failed' ? 'down' : 'accent'), h('b', null, job.label), h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, time(job.startedAt))),
      job.status === 'running' && h('div', { class: 'progress' }, h('div')), job.progress && h('div', { class: 'muted mono' }, job.progress), job.error && h('div', { class: 'down' }, job.error),
      job.notes?.length ? h('pre', null, job.notes.join('\n')) : null, h('div', { class: 'job-result' }));
    return node;
  }
  async function showResult(job) {
    const node = shown.get(job.id);
    if (!node || job.status !== 'done' || !job.hasResult) return;
    const full = (await api.get(`/api/jobs/${job.id}`)).data.result;
    const slot = node.querySelector('.job-result');
    clear(slot).append(h('div', { style: { display: 'grid', gap: '4px', fontSize: '12.5px' } }, full.results.map((item) => h('div', null,
      item.error ? h('span', { class: 'down' }, `${item.label}: ${item.error}`) : [h('b', null, item.label), ' ', item.plannedRequests !== undefined ? `· ${item.plannedRequests} request(s) planned` : `· ${count(item.dataset?.candles)} candles`, ' ', item.files?.length ? h('span', { class: 'muted mono' }, item.files[0]) : ''],
    ))));
    if (job.kind.endsWith('download')) void loadFiles({ quiet: true });
  }
  const offJob = events.on('job', (job) => {
    if (!job.kind.endsWith('download')) return;
    if (!shown.has(job.id)) jobs.prepend(jobCard(job)); else jobCard(job);
    void showResult(job);
  });
  async function start(path, body) {
    try {
      const result = await api.post(path, body);
      if (!shown.has(result.data.id)) jobs.prepend(jobCard(result.data));
    } catch (error) { toast(error.message, { kind: 'error', title: 'Download not started' }); }
  }
  try {
    const list = (await api.get('/api/jobs')).data.filter((job) => job.kind.endsWith('download'));
    if (!list.length) jobs.append(emptyState('No downloads yet', 'Start one with the form; progress shows here live.', { iconName: 'download' }));
    for (const job of list) { jobs.append(jobCard(job)); void showResult(job); }
  } catch { /* jobs list unavailable */ }
  const offEmpty = events.on('job', () => jobs.querySelector('.empty-state')?.remove());

  // ---------- files
  const loadFiles = loader(files, ({ signal }) => api.get('/api/files', undefined, { signal }), (result) => {
    files.append(dataTable({
      name: 'files', rows: result.data.files, search: (row) => `${row.name} ${row.pair} ${row.chain ?? ''}`, exportName: 'data-files',
      columns: [
        { key: 'kind', label: 'Kind', sort: (row) => row.kind, render: (row) => badge(row.kind === 'dex' ? 'Pool' : 'Market', row.kind === 'dex' ? 'accent' : '') },
        { key: 'pair', label: 'Pair', sort: (row) => row.pair, render: (row) => h('b', null, row.pair) },
        { key: 'pool', label: 'Pool', sort: (row) => row.poolName, render: (row) => row.kind === 'dex' ? `${row.dex ?? ''} ${row.version ?? ''} ${row.feeTier !== undefined ? fee(row.feeTier) : ''} · ${chainName(meta, row.chainId)}` : row.sample ? `samples ${row.sample}` : '' },
        { key: 'timeframe', label: 'TF', sort: (row) => row.timeframe, render: (row) => row.timeframe },
        { key: 'range', label: 'Range (UTC)', sort: (row) => row.from, render: (row) => `${time(row.from)} – ${time(row.to)}` },
        { key: 'candles', label: 'Candles', align: 'right', sort: (row) => row.candles, render: (row) => count(row.candles) },
        { key: 'unit', label: 'Unit', sort: (row) => row.priceUnit, render: (row) => h('span', { class: 'muted' }, row.priceUnit ?? ''), hidden: true },
        { key: 'format', label: 'Format', sort: (row) => row.format, render: (row) => h('span', { class: 'mono' }, row.format) },
        { key: 'size', label: 'Size', align: 'right', sort: (row) => row.size, render: (row) => row.size === undefined ? '—' : `${compact(row.size)}B` },
        { key: 'downloaded', label: 'Downloaded', sort: (row) => row.downloadedAt, render: (row) => time(row.downloadedAt) },
        { key: 'actions', label: '', render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } },
          row.kind === 'dex' && h('button', { class: 'btn sm', title: 'Chart this pool', onclick: () => ctx.navigate('chart', { pool: row.pool, chain: row.chain, quote: row.quote, timeframe: row.timeframe, offline: ctx.offline ? 1 : undefined }) }, icon('chart')),
          h('a', { class: 'btn sm', title: 'Download the file', href: `/api/files/raw?kind=${row.kind}&name=${encodeURIComponent(row.name)}`, download: row.name }, icon('download')),
          row.format !== 'json' && h('a', { class: 'btn sm', title: 'Download its .meta.json (pool, units and checks)', href: `/api/files/raw?kind=${row.kind}&name=${encodeURIComponent(`${row.name}.meta.json`)}`, download: `${row.name}.meta.json` }, icon('file'))) },
      ],
      empty: emptyState('No saved files', `Downloads go to ${result.data.dataDir} and ${result.data.marketDir}.`, { iconName: 'file' }),
    }));
  }, { rows: 5 });
  ctx.onRefresh(() => loadFiles({ quiet: true }));
  await loadFiles();
  return () => { offJob(); offEmpty(); loadFiles.abort(); };
}

import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { time, short } from '../format.js';
import { card, dataTable, emptyState, cliHint, field, input, select, badge, toast, kpi } from '../ui.js';
import { walletParams, chainParam } from '../state.js';
import { events } from '../events.js';
import { loader } from './common.js';

// Alerts: run alerts check (range status over RPC; new boundary and out-of-range alerts are saved, repeats suppressed)
// as a background job, and browse the saved alerts.

const TYPES = { near_boundary: ['Near boundary', 'warn'], out_of_range: ['Out of range', 'down'], recovered: ['Recovered', 'up'], stale_data: ['Stale data', ''] };

export async function render(root, ctx) {
  const selection = walletParams();
  const wallet = input({ value: selection.wallet ?? selection.walletAddr ?? '', placeholder: 'default wallet; names, addresses or all', name: 'wallet' });
  const chain = input({ value: chainParam() ?? '', placeholder: 'saved networks', name: 'chain' });
  const protocol = select([['v3', 'v3 (wallet NFTs)'], ['v4', 'v4 (needs IDs)']], { value: 'v3', name: 'protocol' });
  const position = input({ placeholder: '123,456 (v4)', name: 'position' });
  const run = h('button', { class: 'btn primary', type: 'submit', disabled: ctx.readOnly, title: ctx.readOnly ? 'The dashboard runs with --read-only' : undefined }, icon('play'), 'Run check');
  const jobSlot = h('div');
  const kpis = h('div', { class: 'kpis' });
  const body = h('div');
  const analyses = h('div');
  const hint = h('div');
  const form = h('form', { class: 'card', onsubmit: (event) => { event.preventDefault(); void check(); } },
    h('header', null, h('h2', null, 'Check positions now'), h('span', { class: 'sub' }, 'reads ranges over RPC; no key needed'), h('span', { class: 'grow' }), run),
    h('div', { class: 'body', style: { display: 'grid', gap: '12px' } }, h('div', { class: 'form-grid' }, field('Wallets', wallet), field('Networks', chain), field('Version', protocol), field('Position IDs', position)), jobSlot));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Alerts'), h('p', null, 'Boundary and out-of-range alerts for your positions. A repeat of the same status is not raised twice.'))),
    form, kpis, card('Latest check', analyses, { flush: true }), card('Saved alerts', body, { flush: true }), hint);
  const cli = () => `defi-tool alerts check ${wallet.value.trim() ? `--wallet ${wallet.value.trim()}` : ''} ${chain.value.trim() ? `--chain ${chain.value.trim()}` : ''} ${protocol.value === 'v4' ? '--protocol v4' : ''} ${position.value.trim() ? `--position ${position.value.trim()}` : ''}`.replace(/\s+/g, ' ').trim();
  clear(hint).append(cliHint(cli()));

  const load = loader(body, ({ signal }) => api.get('/api/alerts', { limit: 500 }, { signal }), (result) => {
    const rows = result.data;
    const open = rows.filter((row) => !row.acknowledged);
    clear(kpis).append(kpi('Unread', String(open.length), { kind: open.length ? 'bad' : 'good' }), kpi('Out of range', String(rows.filter((row) => row.type === 'out_of_range').length)),
      kpi('Near a boundary', String(rows.filter((row) => row.type === 'near_boundary').length)), kpi('Saved', String(rows.length), { foot: 'in the local database' }));
    body.append(dataTable({
      name: 'alerts', rows, search: (row) => `${row.type} ${row.message} ${row.wallet} ${row.positionId}`, exportName: 'alerts',
      columns: [
        { key: 'time', label: 'Time (UTC)', sort: (row) => row.createdAt, render: (row) => time(row.createdAt) },
        { key: 'type', label: 'Type', sort: (row) => row.type, render: (row) => { const [label, kind] = TYPES[row.type] ?? [row.type, '']; return badge(label, kind); } },
        { key: 'message', label: 'Message', wrap: true, sort: (row) => row.message, render: (row) => h('span', { style: { fontWeight: row.acknowledged ? 400 : 600 } }, row.message) },
        { key: 'wallet', label: 'Wallet', sort: (row) => row.wallet, render: (row) => h('span', { class: 'mono' }, ctx.wallets().find((item) => item.address === row.wallet.toLowerCase())?.name ?? short(row.wallet)) },
        { key: 'position', label: 'Position', sort: (row) => row.positionId, render: (row) => h('span', { class: 'mono' }, `#${row.positionId.split(':').pop()}`) },
        { key: 'ack', label: '', render: (row) => row.acknowledged ? h('span', { class: 'muted' }, 'seen') : h('button', { class: 'btn sm', disabled: ctx.readOnly, onclick: async () => {
          try { await api.post(`/api/alerts/${encodeURIComponent(row.fingerprint)}/ack`); await load({ quiet: true }); void ctx.updateAlerts(); } catch (error) { toast(error.message, { kind: 'error' }); }
        } }, icon('check'), 'Mark seen') },
      ],
      empty: emptyState('No alerts saved', 'Run a check above; alerts appear when a position nears or leaves its range.', { iconName: 'alerts' }),
    }));
  }, { rows: 5 });

  let jobId;
  const offJob = events.on('job', (job) => { if (job.id === jobId) void showJob(job); });
  async function check() {
    clear(hint).append(cliHint(cli()));
    try {
      const result = await api.post('/api/alerts/check', { wallet: wallet.value.trim() || undefined, chain: chain.value.trim() || undefined, protocol: protocol.value, position: position.value.trim() || undefined });
      jobId = result.data.id;
      run.disabled = true;
      void showJob(result.data);
    } catch (error) { toast(error.message, { kind: 'error', title: 'Check not started' }); }
  }
  async function showJob(job) {
    clear(jobSlot).append(h('div', { class: 'job' }, h('div', { class: 'head' }, badge(job.status, job.status === 'done' ? 'up' : job.status === 'failed' ? 'down' : 'accent'), h('b', null, job.label), h('span', { class: 'grow' }), h('span', { class: 'muted' }, time(job.startedAt))),
      job.status === 'running' && h('div', { class: 'progress' }, h('div')), job.progress && h('div', { class: 'muted' }, job.progress), job.error && h('div', { class: 'down' }, job.error),
      job.notes.length ? h('pre', null, job.notes.join('\n')) : null));
    if (job.status === 'running') return;
    run.disabled = ctx.readOnly;
    if (job.status === 'done') {
      const full = (await api.get(`/api/jobs/${job.id}`)).data.result;
      toast(full.fresh.length ? `${full.fresh.length} new alert${full.fresh.length === 1 ? '' : 's'}.` : 'No new alerts.', { kind: full.fresh.length ? 'info' : 'ok', title: 'Check finished' });
      clear(analyses).append(dataTable({
        name: 'alerts-analysis', rows: full.analyses,
        columns: [
          { key: 'id', label: 'Position', sort: (row) => Number(row.id), render: (row) => h('span', { class: 'mono' }, `#${row.id}`) },
          { key: 'chain', label: 'Chain', sort: (row) => row.chainId, render: (row) => ctx.meta.chains.find((item) => item.id === row.chainId)?.name ?? row.chainId },
          { key: 'status', label: 'Status', sort: (row) => row.status, render: (row) => badge(row.status.replaceAll('_', ' '), row.status === 'in_range' ? 'up' : row.status === 'unknown' ? 'warn' : 'down') },
          { key: 'ticks', label: 'Ticks (lower · current · upper)', render: (row) => h('span', { class: 'mono' }, `${row.lowerTick} · ${row.currentTick ?? '?'} · ${row.upperTick}`) },
          { key: 'distance', label: 'To boundary', align: 'right', sort: (row) => row.distanceToBoundaryPct, render: (row) => row.distanceToBoundaryPct === undefined ? '—' : `${row.distanceToBoundaryPct.toFixed(1)}%` },
          { key: 'reason', label: 'Notes', wrap: true, render: (row) => h('span', { class: 'muted' }, row.reason ?? '') },
        ],
        empty: emptyState('No positions found', 'No open v3 NFTs for these wallets on these networks.', { iconName: 'positions' }),
      }));
      if (full.unknown) analyses.prepend(h('div', { class: 'note', style: { margin: '12px' } }, icon('warn'), h('div', null, `${full.unknown} position(s) have unknown range status; that is missing data, not an all-clear.`)));
      await load({ quiet: true });
      void ctx.updateAlerts();
    }
  }
  analyses.append(emptyState('No check yet', 'Run a check to see each position\'s range status here.', { iconName: 'play' }));
  ctx.onRefresh(() => load({ quiet: true }));
  await load();
  if (ctx.params.run && !ctx.readOnly) { ctx.replaceParams({}); void check(); }
  return () => { offJob(); load.abort(); };
}

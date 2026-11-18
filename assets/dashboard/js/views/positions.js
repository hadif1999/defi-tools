import { h, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, signedUsd, tone, count, ago } from '../format.js';
import { kpi, dataTable, emptyState, cliHint, segmented, select } from '../ui.js';
import { walletParams, chainParam, selectionFlags, formValues, rememberForm } from '../state.js';
import { openColumns, closedColumns, positionSearch, loader, rangeState } from './common.js';
import { chainOf } from './overview.js';

// Positions: positions list as two tables (open and closed), with filters, sorting, column choice and CSV export.
// A row opens the in-depth report (positions detail).

export async function render(root, ctx) {
  const saved = formValues('positions', { tab: 'active', source: 'auto', status: 'all' });
  let tab = ctx.params.tab ?? saved.tab;
  let source = saved.source;
  let status = saved.status;
  let last;
  const scope = h('p', { class: 'muted', style: { margin: '4px 0 0' } });
  const stamp = h('span', { class: 'muted', style: { fontSize: '12px' } });
  const notes = h('div');
  const kpis = h('div', { class: 'kpis' });
  const body = h('div');
  const hint = h('div');
  const statusSelect = select([['all', 'Any status'], ['in', 'In range'], ['near', 'Near a limit'], ['out', 'Out of range']], { value: status, style: { height: '30px', width: '150px' }, 'aria-label': 'Status filter', onchange: (event) => { status = event.target.value; persist(); draw(); } });
  const sourceSelect = select([['auto', 'Revert, then RPC'], ['revert', 'Revert Finance only'], ['rpc', 'On-chain RPC only']], { value: source, style: { height: '34px', width: '180px' }, 'aria-label': 'Data source', onchange: (event) => { source = event.target.value; persist(); load(); } });
  const tabs = segmented([['active', 'Open'], ['past', 'Closed']], tab, (next) => { tab = next; persist(); ctx.replaceParams({ tab }); draw(); }, { label: 'Open or closed' });
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Positions'), scope), h('span', { class: 'grow' }), stamp, sourceSelect), notes, kpis,
    h('section', { class: 'card' }, h('header', null, tabs, h('span', { class: 'grow' })), h('div', { class: 'body flush' }, body)), hint);

  const persist = () => rememberForm('positions', { tab, source, status });
  const matchesStatus = (row) => {
    if (status === 'all') return true;
    const key = rangeState(row).key;
    return status === 'in' ? key === 'in' : status === 'near' ? key === 'near' : ['below', 'above', 'out'].includes(key);
  };

  function draw() {
    if (!last) return;
    const { active, past, summary } = last.data;
    clear(kpis).append(
      kpi('Open value', usd(summary.valueUsd ?? 0), { kind: 'accent', foot: `${count(summary.open)} open positions` }),
      kpi('Unclaimed fees', usd(summary.uncollectedFeesUsd ?? 0)),
      kpi('Lifetime fees', usd(summary.feesEarnedUsd), { kind: 'good' }),
      kpi('PnL', signedUsd(summary.pnlUsd), { tone: tone(summary.pnlUsd), kind: summary.pnlUsd < 0 ? 'bad' : 'good' }),
      kpi('In range', `${count(summary.inRange)} / ${count(summary.open)}`, { kind: summary.outOfRange ? 'bad' : 'good', foot: summary.outOfRange ? `${summary.outOfRange} out of range` : undefined }),
      kpi('Closed', count(summary.closed), { foot: 'all liquidity withdrawn' }),
    );
    const rows = tab === 'active' ? active.filter(matchesStatus) : past;
    const several = new Set([...active, ...past].map((row) => row.wallet)).size > 1;
    clear(body).append(dataTable({
      name: `positions-${tab}`, rows, search: positionSearch, exportName: `positions-${tab === 'active' ? 'open' : 'closed'}`,
      columns: tab === 'active' ? openColumns(ctx.meta, { several }) : closedColumns(ctx.meta, { several }),
      toolbar: tab === 'active' ? statusSelect : null,
      onRow: (row) => ctx.navigate('position', { id: row.id, chain: chainOf(ctx, row), past: row.active ? undefined : 1 }),
      empty: emptyState(tab === 'active' ? 'No open positions' : 'No closed positions', tab === 'active' && status !== 'all' ? 'None match the status filter.' : 'Choose other wallets or networks in the top bar.', { iconName: 'positions' }),
    }));
    tabs.querySelectorAll('button').forEach((button, index) => { button.textContent = `${index ? 'Closed' : 'Open'} (${index ? past.length : active.length})`; });
    clear(hint).append(cliHint(`defi-tool positions list ${selectionFlags()}${tab === 'past' ? ' --past' : ' --active'}${source !== 'auto' ? ` --source ${source}` : ''}`.replace(/\s+/g, ' ').trim()));
  }

  const load = loader(body, ({ signal, refresh }) => api.get('/api/positions', { ...walletParams(), chain: chainParam(), source, refresh }, { signal }), (result) => {
    last = result;
    scope.textContent = result.data.scope.join(' · ') || 'No wallets';
    stamp.textContent = `${result.data.source} · ${result.cached ? 'cached' : 'updated'} ${ago(result.cachedAt)}`;
    draw();
  }, { rows: 6, notesSlot: notes });
  ctx.onRefresh(({ force } = {}) => load({ quiet: true, force }));
  await load();
  return () => load.abort();
}


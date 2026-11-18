import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, signedUsd, tone, count, time, ago, short } from '../format.js';
import { card, kpi, donut, legend, dataTable, emptyState, badge, cliHint, skeleton, errorBox, notesBanner } from '../ui.js';
import { walletParams, chainParam, selectionFlags } from '../state.js';
import { openColumns, rangeState, positionSearch, pageHead, priceView } from './common.js';

// Overview: the portfolio at a glance for the selected wallets: value, fees, PnL, range health, allocation, positions
// that need attention, wallet balances and the latest alerts.

export async function render(root, ctx) {
  const scope = h('p', { class: 'muted', style: { margin: '4px 0 0' } }, 'Loading…');
  const refreshed = h('span', { class: 'muted', style: { fontSize: '12px' } });
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Overview'), scope), h('span', { class: 'grow' }), refreshed));
  const notes = h('div');
  const kpis = h('div', { class: 'kpis' }, Array.from({ length: 6 }, () => h('div', { class: 'kpi' }, h('span', { class: 'skeleton', style: { height: '14px', width: '50%' } }), h('span', { class: 'skeleton', style: { height: '26px', width: '70%' } }))));
  const attention = h('div', null, skeleton(3));
  const allocation = h('div', null, skeleton(3));
  const openTable = h('div', null, skeleton(5));
  const balances = h('div', null, skeleton(3));
  const alerts = h('div', null, skeleton(3));
  root.append(notes, kpis,
    h('div', { class: 'grid side-r' },
      card('Open positions', openTable, { flush: true, actions: h('a', { class: 'btn sm', href: '#/positions' }, 'All positions', icon('arrow')) }),
      h('div', { class: 'grid' }, card('Needs attention', attention, { sub: 'out of range or near a limit' }), card('Allocation', allocation, { sub: 'open value' }))),
    h('div', { class: 'grid two' },
      card('Wallet balances', balances, { flush: true, actions: h('a', { class: 'btn sm', href: '#/wallets' }, 'Wallets', icon('arrow')) }),
      card('Latest alerts', alerts, { flush: true, actions: h('a', { class: 'btn sm', href: '#/alerts' }, 'Alerts', icon('arrow')) })),
    cliHint(`defi-tool positions list ${selectionFlags()}`.trim()));

  let controller;
  async function load({ force = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const positions = api.get('/api/positions', { ...walletParams(), chain: chainParam(), refresh: force }, { signal });
    const wallets = api.get('/api/wallets', { balances: 1, refresh: force }, { signal });
    const alertList = api.get('/api/alerts', { limit: 6 }, { signal });

    positions.then((result) => {
      const { summary, active, past, scope: scopes } = result.data;
      scope.textContent = scopes.join(' · ') || 'No wallets';
      refreshed.textContent = `${result.cached ? 'Cached' : 'Updated'} ${ago(result.cachedAt)}`;
      clear(notes);
      const banner = notesBanner(result.notes);
      if (banner) notes.append(banner);
      clear(kpis).append(
        kpi('Open value', usd(summary.valueUsd ?? 0), { kind: 'accent', foot: `${count(summary.open)} open · ${count(summary.closed)} closed` }),
        kpi('Unclaimed fees', usd(summary.uncollectedFeesUsd ?? 0), { foot: 'ready to collect' }),
        kpi('Lifetime fees', usd(summary.feesEarnedUsd), { kind: 'good', foot: 'collected + unclaimed, all positions' }),
        kpi('PnL', signedUsd(summary.pnlUsd), { tone: tone(summary.pnlUsd), kind: summary.pnlUsd < 0 ? 'bad' : 'good', foot: `open ${signedUsd(summary.openPnlUsd)} · gas ${usd(summary.gasUsd)}` }),
        kpi('Impermanent loss', signedUsd(summary.ilUsd), { tone: tone(summary.ilUsd), foot: 'vs. holding the deposited tokens' }),
        kpi('Range health', `${count(summary.inRange)} / ${count(summary.open)}`, { kind: summary.outOfRange ? 'bad' : 'good', foot: summary.outOfRange ? `${summary.outOfRange} out of range` : summary.open ? 'all open positions in range' : 'no open positions', tone: summary.outOfRange ? 'down' : '' }),
      );

      // Attention list: out of range first, then near a limit.
      const flagged = active.map((position) => ({ position, state: rangeState(position) })).filter(({ state }) => ['below', 'above', 'out', 'near', 'unknown'].includes(state.key))
        .sort((a, b) => (a.state.kind === 'down' ? 0 : 1) - (b.state.kind === 'down' ? 0 : 1) || (b.position.valueUsd ?? 0) - (a.position.valueUsd ?? 0));
      clear(attention).append(flagged.length ? h('div', { style: { display: 'grid', gap: '8px' } }, flagged.slice(0, 6).map(({ position, state }) => {
        const view = priceView(position);
        return h('a', { class: 'option', href: `#/position?id=${position.id}&chain=${chainOf(ctx, position)}`, style: { textDecoration: 'none', color: 'inherit', border: '1px solid var(--line)' } },
          h('b', null, `${position.token0.symbol}/${position.token1.symbol}`), h('span', { class: 'muted mono' }, `#${position.id}`), badge(state.label, state.kind),
          h('span', { class: 'meta' }, `${usd(position.valueUsd)} · ${view.unit}`));
      })) : emptyState('All clear', active.length ? 'Every open position is inside its range.' : 'No open positions.', { iconName: 'check' }));

      // Allocation by chain and pool.
      clear(allocation);
      if (!summary.byChain.length || !summary.valueUsd) allocation.append(emptyState('No open value', 'Allocation shows once a position is open.', { iconName: 'overview' }));
      else {
        const pools = summary.byPool.slice(0, 6);
        const rest = summary.byPool.slice(6).reduce((total, item) => total + item.value, 0);
        if (rest > 0) pools.push({ label: 'Other', value: rest });
        allocation.append(h('div', { class: 'donut-wrap' }, donut(pools.map((item) => ({ ...item, display: usd(item.value) })), { label: usd(summary.valueUsd), sub: `${summary.byPool.length} pools` }), legend(pools, usd)),
          h('div', { style: { marginTop: '14px' } }, legend(summary.byChain, usd)));
      }

      clear(openTable).append(active.length ? dataTable({
        name: 'overview-open', rows: active, columns: openColumns(ctx.meta, { several: new Set(active.map((row) => row.wallet)).size > 1 }).filter((column) => ['pool', 'status', 'range', 'value', 'unclaimed', 'pnl'].includes(column.key)),
        onRow: (row) => ctx.navigate('position', { id: row.id, chain: chainOf(ctx, row) }), search: positionSearch, pageSize: 8,
      }) : emptyState('No open positions', past.length ? `${past.length} closed position${past.length === 1 ? '' : 's'} on the Positions page.` : 'Choose wallets in the top bar, or add one on the Wallets page.', { iconName: 'positions' }));
    }).catch((error) => {
      if (error.name === 'AbortError') return;
      scope.textContent = '';
      clear(kpis);
      clear(notes).append(errorBox(error, () => load({ force: true })));
      clear(openTable).append(emptyState('Positions unavailable', error.message, { iconName: 'warn' }));
      clear(attention); clear(allocation);
    });

    wallets.then((result) => {
      const rows = result.data;
      const total = rows.reduce((sum, wallet) => sum + (wallet.balance?.valueUsd ?? 0), 0);
      clear(balances).append(rows.length ? dataTable({
        name: 'overview-wallets', rows, pageSize: 6,
        columns: [
          { key: 'name', label: 'Wallet', sort: (row) => row.name, render: (row) => h('span', null, h('b', null, row.name), row.default ? h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, '★') : null) },
          { key: 'chain', label: 'Network', sort: (row) => row.chainName, render: (row) => row.chainName },
          { key: 'address', label: 'Address', render: (row) => h('span', { class: 'mono muted' }, short(row.address)), csv: (row) => row.address },
          { key: 'balance', label: 'Balance', align: 'right', sort: (row) => row.balance?.valueUsd, render: (row) => row.balanceError ? h('span', { class: 'muted', title: row.balanceError }, 'unavailable') : h('b', null, usd(row.balance?.valueUsd)) },
        ],
        toolbar: h('span', { class: 'muted' }, `Total ${usd(total)}`),
        onRow: (row) => ctx.navigate('history', { wallet: row.name }),
      }) : emptyState('No saved wallets', 'Save one on the Wallets page.', { iconName: 'wallets', action: h('a', { class: 'btn primary sm', href: '#/wallets?add=1' }, icon('plus'), 'Add wallet') }));
    }).catch((error) => { if (error.name !== 'AbortError') clear(balances).append(errorBox(error, () => load({ force: true }))); });

    alertList.then((result) => {
      clear(alerts).append(result.data.length ? h('div', { style: { display: 'grid' } }, result.data.map((alert) => h('div', { class: 'option', style: { borderRadius: 0, borderBottom: '1px solid var(--line-2)', cursor: 'default' } },
        badge(alert.type.replace('_', ' '), alert.type === 'out_of_range' ? 'down' : alert.type === 'recovered' ? 'up' : 'warn'), h('span', { style: { whiteSpace: 'normal' } }, alert.message), h('span', { class: 'meta' }, time(alert.createdAt))))) : emptyState('No alerts yet', 'Run a check on the Alerts page.', { iconName: 'alerts' }));
    }).catch((error) => { if (error.name !== 'AbortError') clear(alerts).append(errorBox(error)); });

    await Promise.allSettled([positions, wallets, alertList]);
  }
  ctx.onRefresh(({ force } = {}) => load({ force }));
  await load();
  return () => controller?.abort();
}

export const chainOf = (ctx, position) => ctx.meta.chains.find((chain) => chain.id === position.chainId)?.slug ?? position.chainId;

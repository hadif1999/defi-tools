import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, signedUsd, num, time, short, ago, chainName } from '../format.js';
import { card, dataTable, emptyState, cliHint, field, input, select, kpi, badge } from '../ui.js';
import { formValues, rememberForm } from '../state.js';
import { loader } from './common.js';

// Wallet history: swaps, liquidity adds and removes, fee collects and transfers, valued when they happened (wallet history).

const LABELS = { swap: 'Swap', 'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'collect-fees': 'Collect fees', send: 'Send', receive: 'Receive', wrap: 'Wrap', unwrap: 'Unwrap', other: 'Other' };
const KINDS = { swap: 'accent', 'add-liquidity': 'up', 'remove-liquidity': 'down', 'collect-fees': 'up', send: 'warn', receive: '', wrap: '', unwrap: '', other: '' };

const legs = (list = []) => list.map((leg) => `${num(leg.amount)} ${leg.symbol}`).join(' + ') || '—';
const priced = (list = []) => list.length > 0 && list.every((leg) => leg.valueUsd !== undefined);
const total = (list = []) => list.reduce((sum, leg) => sum + (leg.valueUsd ?? 0), 0);
const value = (activity) => { const list = ['receive', 'remove-liquidity', 'collect-fees'].includes(activity.kind) ? activity.received : activity.sent; return priced(list) ? total(list) : undefined; };
const swapResult = (activity) => ['swap', 'wrap', 'unwrap'].includes(activity.kind) && priced(activity.sent) && priced(activity.received) ? total(activity.received) - total(activity.sent) : undefined;

function details(activity) {
  const position = activity.pool ? `${activity.pool}${activity.positionId ? ` #${activity.positionId}` : ''}` : '';
  const others = (activity.counterparty ?? '').split(', ').filter(Boolean).map(short).join(', ');
  switch (activity.kind) {
    case 'add-liquidity': return `${legs(activity.sent)} → ${position}`;
    case 'remove-liquidity': return `${position} → ${legs(activity.received)}${activity.fees?.length ? ` + fees ${legs(activity.fees)}` : ''}`;
    case 'collect-fees': return `${position} → ${legs(activity.received)}`;
    case 'send': return `${legs(activity.sent)} → ${others}`;
    case 'receive': return `${legs(activity.received)} ← ${others}`;
    default: { const result = swapResult(activity); return `${legs(activity.sent)} → ${legs(activity.received)}${result !== undefined && Math.abs(result) >= 0.005 ? ` (${signedUsd(result)})` : ''}`; }
  }
}

export async function render(root, ctx) {
  const wallets = ctx.wallets().filter((wallet) => wallet.type === 'evm');
  const saved = formValues('history', { wallet: '', chain: '', days: '30', type: '', top: '100', all: false });
  const values = { ...saved, ...ctx.params };
  if (!values.wallet) values.wallet = wallets.find((wallet) => wallet.default)?.name ?? wallets[0]?.name ?? '';
  const walletSelect = select([...wallets.map((wallet) => [wallet.name, `${wallet.name} · ${short(wallet.address)}`]), ...(wallets.length > 1 ? [['all', 'All saved wallets']] : [])], { value: values.wallet, name: 'wallet' });
  const addressInput = input({ placeholder: 'or any 0x address', value: /^0x/i.test(values.wallet) ? values.wallet : '', name: 'address' });
  const chain = input({ value: values.chain, placeholder: "wallet's network (all for an address)", name: 'chain' });
  const days = input({ value: values.days, type: 'number', min: 1, max: 365, name: 'days' });
  const type = select([['', 'Every kind'], ['lp', 'Liquidity (add, remove, collect)'], ...ctx.meta.activityKinds.map((kind) => [kind, LABELS[kind] ?? kind])], { value: values.type, name: 'type' });
  const top = input({ value: values.top, type: 'number', min: 1, max: 500, name: 'top' });
  const spam = h('input', { type: 'checkbox', checked: values.all === true || values.all === '1' });
  const kpis = h('div', { class: 'kpis' });
  const body = h('div');
  const notes = h('div');
  const hint = h('div');
  const stamp = h('span', { class: 'muted', style: { fontSize: '12px' } });
  const form = h('form', { class: 'card', onsubmit: (event) => { event.preventDefault(); search(); } },
    h('header', null, h('h2', null, 'Wallet history'), h('span', { class: 'grow' }), h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Show')),
    h('div', { class: 'body' }, h('div', { class: 'form-grid' }, wallets.length ? field('Wallet', walletSelect) : null, field('Address', addressInput), field('Networks', chain), field('Days', days, { hint: '1–365' }), field('Kinds', type), field('Rows', top),
      h('label', { class: 'check', style: { alignSelf: 'center' } }, spam, 'Show likely spam'))));
  root.append(h('button', { class: 'btn ghost sm', style: { justifySelf: 'start' }, onclick: () => ctx.navigate('wallets') }, icon('back'), 'Wallets'), form, notes, kpis, card('Transactions', body, { flush: true, actions: stamp }), hint);

  let query;
  const load = loader(body, ({ signal, refresh }) => api.get('/api/history', { ...query, refresh }, { signal }), (result) => {
    const data = result.data;
    stamp.textContent = `${[...new Set(data.wallets.flatMap((item) => item.sources))].join(' and ') || 'no sources'} · ${result.cached ? 'cached' : 'updated'} ${ago(result.cachedAt)}`;
    const activities = data.wallets.flatMap((item) => item.activities.map((activity) => ({ ...activity, walletLabel: item.wallets.join(', ') || short(item.address) })));
    const sum = (key) => data.wallets.reduce((total, item) => total + (item.summary[key] ?? 0), 0);
    clear(kpis).append(
      kpi('Transactions', String(activities.length), { kind: 'accent', foot: `${data.wallets.reduce((total, item) => total + item.total, 0)} in ${data.days} days${data.wallets.some((item) => item.spamHidden) ? ` · ${data.wallets.reduce((total, item) => total + item.spamHidden, 0)} spam hidden` : ''}` }),
      kpi('Swapped', usd(sum('swapVolumeUsd')), { foot: `cost ${usd(Math.max(0, sum('swapCostUsd')))}` }),
      kpi('Liquidity added', usd(sum('addedUsd')), { foot: `removed ${usd(sum('removedUsd'))}` }),
      kpi('Fees collected', usd(sum('feesCollectedUsd')), { kind: 'good' }),
      kpi('Gas', usd(sum('gasUsd')), { foot: 'transactions this wallet sent' }));
    const several = data.wallets.length > 1;
    body.append(dataTable({
      name: 'history', rows: activities, pageSize: 50, exportName: 'wallet-history',
      search: (row) => `${row.kind} ${details(row)} ${row.hash} ${row.walletLabel}`,
      columns: [
        { key: 'time', label: 'Time (UTC)', sort: (row) => row.timestamp, render: (row) => time(row.timestamp) },
        { key: 'wallet', label: 'Wallet', sort: (row) => row.walletLabel, render: (row) => row.walletLabel, hidden: !several },
        { key: 'chain', label: 'Chain', sort: (row) => row.chainId, render: (row) => chainName(ctx.meta, row.chainId) },
        { key: 'type', label: 'Type', sort: (row) => row.kind, render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap' } }, badge(LABELS[row.kind] ?? row.kind, KINDS[row.kind]), row.spam && badge('spam?', 'warn')) },
        { key: 'details', label: 'Details', wrap: true, sort: details, render: (row) => details(row) },
        { key: 'value', label: 'Value', align: 'right', sort: value, render: (row) => usd(value(row)) },
        { key: 'gas', label: 'Gas', align: 'right', sort: (row) => row.gasUsd, render: (row) => row.gasUsd !== undefined ? usd(row.gasUsd) : '—' },
        { key: 'tx', label: 'Tx', sort: (row) => row.hash, render: (row) => row.explorerUrl ? h('a', { href: row.explorerUrl, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, short(row.hash)) : h('span', { class: 'mono' }, short(row.hash)), csv: (row) => row.hash },
      ],
      empty: emptyState('No transactions', 'Try more days, other networks, or fewer kinds.', { iconName: 'history' }),
    }));
  }, { rows: 8, notesSlot: notes });

  function search() {
    const wallet = addressInput.value.trim() || walletSelect.value;
    query = { wallet: wallet || undefined, chain: chain.value.trim() || undefined, days: days.value || '30', type: type.value || undefined, top: top.value || '100', all: spam.checked || undefined };
    rememberForm('history', { ...query, wallet: '' });
    ctx.replaceParams({ wallet });
    clear(hint).append(cliHint(`defi-tool wallet history ${wallet}${query.chain ? ` --chain ${query.chain}` : ''} --days ${query.days}${query.type ? ` --type ${query.type}` : ''} --top ${query.top}${query.all ? ' --all' : ''}`));
    void load();
  }
  if (!values.wallet && !wallets.length) {
    body.append(emptyState('No wallet chosen', 'Enter a 0x address above, or save a wallet first.', { iconName: 'history' }));
    return () => load.abort();
  }
  ctx.onRefresh(({ force } = {}) => load({ quiet: true, force }));
  search();
  return () => load.abort();
}

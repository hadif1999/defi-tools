import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, num, time, short, ago } from '../format.js';
import { card, dataTable, emptyState, cliHint, field, input, select, modal, confirmDialog, toast, badge, copyButton, kpi } from '../ui.js';
import { state, update } from '../state.js';
import { loader } from './common.js';

// Wallets: saved wallets with live balances, and wallet add / edit / delete / set-default with the CLI's own rules
// (the server runs the same validation and returns its messages).

export async function render(root, ctx) {
  const kpis = h('div', { class: 'kpis' });
  const body = h('div');
  const notes = h('div');
  const stamp = h('span', { class: 'muted', style: { fontSize: '12px' } });
  const addButton = h('button', { class: 'btn primary', disabled: ctx.readOnly, title: ctx.readOnly ? 'The dashboard runs with --read-only' : undefined, onclick: () => walletForm() }, icon('plus'), 'Add wallet');
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Wallets'), h('p', null, 'Saved in the same database the CLI uses: only public addresses, never keys.')), h('span', { class: 'grow' }), stamp, addButton),
    notes, kpis, card('Saved wallets', body, { flush: true }),
    h('div', { class: 'grid two' }, cliHint('defi-tool wallet list'), cliHint('defi-tool wallet add 0xYourWallet --chain base --name my-wallet')));

  const chains = ctx.meta.chains.map((chain) => [chain.slug, chain.name]);

  function walletForm(existing) {
    const address = input({ value: existing?.address ?? '', placeholder: '0x… or a Solana address', disabled: Boolean(existing), name: 'address' });
    const chain = select(chains, { value: existing?.chain ?? 'eth', name: 'chain' });
    const name = input({ value: existing?.name ?? '', placeholder: 'wallet0, wallet1, … when empty', name: 'name', maxlength: 30 });
    const fields = { address: field('Address', address, { hint: existing ? 'To change the address, delete the wallet and add it again.' : 'EVM addresses are saved lowercase.' }), chain: field('Network', chain, { hint: 'An EVM address is the same on every EVM network; positions read all of them.' }), name: field('Name', name, { hint: 'Up to 30 letters, digits, ".", "_" or "-". "all" is reserved.' }) };
    const makeDefault = h('input', { type: 'checkbox' });
    const general = h('div', { class: 'note error', hidden: true });
    modal({
      title: existing ? `Edit ${existing.name}` : 'Add a wallet',
      body: h('form', { style: { display: 'grid', gap: '14px' }, onsubmit: (event) => event.preventDefault() }, general, fields.address, fields.chain, fields.name, !existing && h('label', { class: 'check' }, makeDefault, 'Make it the default wallet')),
      actions: [{ label: 'Cancel' }, { label: existing ? 'Save' : 'Add wallet', kind: 'primary', submit: true, run: async () => {
        Object.values(fields).forEach((item) => item.setError());
        general.hidden = true;
        try {
          let saved;
          if (existing) {
            const changes = {};
            if (name.value.trim() && name.value.trim() !== existing.name) changes.name = name.value.trim();
            if (chain.value !== existing.chain) changes.chain = chain.value;
            if (!Object.keys(changes).length) return true;
            saved = (await api.patch(`/api/wallets/${encodeURIComponent(existing.name)}`, changes)).data;
            // Keep the selection pointing at the renamed wallet.
            if (state.wallets.names.includes(existing.name)) update('wallets', { ...state.wallets, names: state.wallets.names.map((item) => item === existing.name ? saved.name : item) });
            toast(`${existing.name} is now ${saved.name} on ${chains.find(([slug]) => slug === chain.value)?.[1]}.`, { kind: 'ok', title: 'Wallet updated' });
          } else {
            saved = (await api.post('/api/wallets', { address: address.value.trim(), chain: chain.value, name: name.value.trim() || undefined })).data;
            if (makeDefault.checked) await api.put('/api/wallets/default', { wallet: saved.name });
            toast(`${saved.name}: ${short(saved.address)}${saved.default || makeDefault.checked ? ' — now the default wallet' : ''}.`, { kind: 'ok', title: 'Wallet saved' });
          }
          await ctx.reloadWallets();
          await load({ quiet: true });
          return true;
        } catch (error) {
          const message = error.message;
          const target = /address/i.test(message) ? fields.address : /name|reserved/i.test(message) ? fields.name : /chain|network/i.test(message) ? fields.chain : undefined;
          if (target) target.setError(message); else { general.hidden = false; general.textContent = message; }
          return false;
        }
      } }],
    });
  }

  async function remove(wallet) {
    if (!await confirmDialog({ title: `Delete ${wallet.name}?`, message: `${wallet.address} on ${wallet.chainName} is removed from the saved wallets. Positions and alerts already recorded for it stay in the database.`, confirm: 'Delete', danger: true })) return;
    try {
      await api.delete(`/api/wallets/${encodeURIComponent(wallet.name)}`);
      if (state.wallets.names.includes(wallet.name)) update('wallets', { ...state.wallets, names: state.wallets.names.filter((item) => item !== wallet.name) });
      toast(`${wallet.name} deleted.`, { kind: 'ok' });
      await ctx.reloadWallets();
      await load({ quiet: true });
    } catch (error) { toast(error.message, { kind: 'error' }); }
  }

  async function makeDefault(wallet) {
    try {
      await api.put('/api/wallets/default', { wallet: wallet.name });
      toast(`${wallet.name} is the default wallet: commands use it when --wallet is left out.`, { kind: 'ok' });
      await ctx.reloadWallets();
      await load({ quiet: true });
    } catch (error) { toast(error.message, { kind: 'error' }); }
  }

  const load = loader(body, ({ signal, refresh }) => api.get('/api/wallets', { balances: 1, refresh }, { signal }), (result) => {
    const rows = result.data;
    const total = rows.reduce((sum, wallet) => sum + (wallet.balance?.valueUsd ?? 0), 0);
    stamp.textContent = result.cachedAt ? `balances ${ago(result.cachedAt)}` : '';
    clear(kpis).append(kpi('Saved wallets', String(rows.length), { kind: 'accent', foot: `${rows.filter((row) => row.type === 'evm').length} EVM · ${rows.filter((row) => row.type !== 'evm').length} Solana` }),
      kpi('Total balance', usd(total), { foot: 'native coin + well-known tokens' }),
      kpi('Default wallet', result.default?.name ?? '—', { foot: result.default ? (result.default.chosen ? 'chosen with set-default' : 'the latest added') : 'none saved' }),
      result.initWallets ? kpi('From init', String(result.initWallets), { foot: 'addresses in the config file' }) : null);
    const failed = rows.filter((row) => row.balanceError);
    clear(notes);
    if (failed.length) notes.append(h('div', { class: 'note' }, icon('warn'), h('div', null, `Balances unavailable: ${failed.map((row) => `${row.name} (${row.balanceError})`).join('; ')}`)));
    body.append(dataTable({
      name: 'wallets', rows, search: (row) => `${row.name} ${row.address} ${row.chainName}`,
      columns: [
        { key: 'number', label: '#', align: 'right', sort: (row) => row.number, render: (row) => h('span', { class: 'muted' }, String(row.number)) },
        { key: 'name', label: 'Name', sort: (row) => row.name, render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap' } }, h('b', null, row.name), row.default && badge(row.chosenDefault ? '★ default' : '★ latest', 'accent')) },
        { key: 'chain', label: 'Network', sort: (row) => row.chainName, render: (row) => row.chainName },
        { key: 'type', label: 'Type', sort: (row) => row.type, render: (row) => badge(row.type === 'evm' ? 'EVM' : 'Solana') },
        { key: 'address', label: 'Address', sort: (row) => row.address, render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap' } }, h('span', { class: 'mono' }, short(row.address)), copyButton(row.address, 'Copy address')) },
        { key: 'balance', label: 'Balance', align: 'right', sort: (row) => row.balance?.valueUsd, render: (row) => row.balanceError ? h('span', { class: 'muted', title: row.balanceError }, 'unavailable') : h('b', null, usd(row.balance?.valueUsd)) },
        { key: 'holdings', label: 'Holdings', wrap: true, render: (row) => h('span', { class: 'muted', style: { fontSize: '12.5px' } }, (row.balance?.holdings ?? []).filter((item) => item.amount > 0).map((item) => `${num(item.amount)} ${item.symbol}`).join(', ') || (row.balance ? 'empty' : '—')), csv: (row) => (row.balance?.holdings ?? []).map((item) => `${item.amount} ${item.symbol}`).join('; ') },
        { key: 'added', label: 'Added (UTC)', sort: (row) => row.createdAt, render: (row) => time(row.createdAt), hidden: true },
        { key: 'updated', label: 'Updated (UTC)', sort: (row) => row.updatedAt, render: (row) => row.updatedAt === row.createdAt ? '—' : time(row.updatedAt), hidden: true },
        { key: 'actions', label: '', render: (row) => h('span', { class: 'split', style: { flexWrap: 'nowrap', justifyContent: 'flex-end' } },
          h('button', { class: 'btn sm', onclick: () => { update('wallets', { mode: 'pick', names: [row.name], addresses: [] }); ctx.reloadWallets(); ctx.navigate('positions'); }, disabled: row.type !== 'evm', title: 'Show its positions' }, icon('positions')),
          h('button', { class: 'btn sm', onclick: () => ctx.navigate('history', { wallet: row.name }), disabled: row.type !== 'evm', title: 'Transaction history' }, icon('history')),
          h('button', { class: 'btn sm', onclick: () => makeDefault(row), disabled: ctx.readOnly || row.chosenDefault, title: 'Make default' }, icon('star')),
          h('button', { class: 'btn sm', onclick: () => walletForm(row), disabled: ctx.readOnly, title: 'Edit' }, icon('edit')),
          h('button', { class: 'btn sm danger', onclick: () => remove(row), disabled: ctx.readOnly, title: 'Delete' }, icon('trash'))) },
      ],
      onRow: (row) => row.type === 'evm' && ctx.navigate('history', { wallet: row.name }),
      empty: emptyState('No saved wallets', 'Add a wallet to follow its positions, balances and history.', { iconName: 'wallets', action: ctx.readOnly ? null : h('button', { class: 'btn primary', onclick: () => walletForm() }, icon('plus'), 'Add wallet') }),
    }));
  }, { rows: 4 });

  ctx.onRefresh(({ force } = {}) => load({ quiet: true, force }));
  await load();
  if (ctx.params.add && !ctx.readOnly) { ctx.replaceParams({}); walletForm(); }
  return () => load.abort();
}

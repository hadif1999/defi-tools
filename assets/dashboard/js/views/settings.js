import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { card, cliHint, badge, confirmDialog, toast, segmented } from '../ui.js';
import { currentTheme, setTheme, resetAll, state, update } from '../state.js';

// Settings: what the server runs with (configuration, data folders, keys present — never their values), and this
// browser's preferences.

export async function render(root, ctx) {
  const meta = ctx.meta;
  const config = meta.config;
  const health = h('dl', { class: 'kv' });
  const yes = (value, text = 'configured') => value ? badge(text, 'up') : badge('not set');
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('p', null, 'The dashboard shares the CLI\'s configuration, database and data folders.'))),
    h('div', { class: 'grid two' },
      card('Configuration', h('dl', { class: 'kv' },
        h('dt', null, 'Version'), h('dd', null, meta.version),
        h('dt', null, 'Saved networks'), h('dd', null, config.chains.join(', ')),
        h('dt', null, 'Database'), h('dd', { class: 'mono' }, config.databasePath),
        h('dt', null, 'Pool candles'), h('dd', { class: 'mono' }, meta.dashboard.dataDir),
        h('dt', null, 'Market prices'), h('dd', { class: 'mono' }, meta.dashboard.marketDir),
        h('dt', null, 'Custom RPC URLs'), h('dd', null, config.rpcConfigured.length ? config.rpcConfigured.join(', ') : badge('public defaults')),
        h('dt', null, 'Alchemy key'), h('dd', null, yes(config.alchemy), config.alchemy ? '' : h('span', { class: 'muted' }, ' · swaps and transfers in wallet history need it (ALCHEMY_API_KEY)')),
        h('dt', null, 'Custom pool provider'), h('dd', null, yes(config.customProvider, 'in use')),
        h('dt', null, 'Wallets from init'), h('dd', null, String(config.initWallets)),
        h('dt', null, 'Near-boundary threshold'), h('dd', null, `${(config.saturationThresholdPct * 100).toFixed(0)}% of the range`),
      ), { sub: 'read-only here; edit with defi-tool init or the config file' }),
      card('Server', health, { sub: 'this dashboard process' })),
    card('This browser', h('div', { style: { display: 'grid', gap: '16px' } },
      h('div', { class: 'toolbar' }, h('b', { style: { width: '160px' } }, 'Theme'), segmented([['light', 'Light'], ['dark', 'Dark']], currentTheme(), (next) => { setTheme(next); location.reload(); }, { label: 'Theme' })),
      h('div', { class: 'toolbar' }, h('b', { style: { width: '160px' } }, 'Auto-refresh'), segmented([['on', `Every ${Math.round(meta.dashboard.refreshMs / 1000)} s`], ['off', 'Off']], state.autoRefresh ? 'on' : 'off', (next) => update('autoRefresh', next === 'on'), { label: 'Auto-refresh' }),
        h('span', { class: 'muted' }, 'The interval is set with dashboard serve --refresh.')),
      h('div', { class: 'toolbar' }, h('b', { style: { width: '160px' } }, 'Saved views'), h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog({ title: 'Reset this browser\'s dashboard settings?', message: 'The wallet selection, networks, watchlist, table columns and remembered forms go back to their defaults. Saved wallets and data are not touched.', confirm: 'Reset', danger: true })) return;
        resetAll();
        toast('Reset. Reloading…', { kind: 'ok' });
        setTimeout(() => location.reload(), 600);
      } }, icon('trash'), 'Reset'), h('span', { class: 'muted' }, 'Wallet selection, watchlist, table columns and forms are kept in this browser only.'))),
    ),
    card('Command line', h('div', { style: { display: 'grid', gap: '8px' } }, cliHint('defi-tool dashboard serve --port 8787'), cliHint('defi-tool dashboard serve --read-only --no-open'), cliHint('defi-tool dashboard serve --help'))));

  async function load() {
    try {
      const result = await api.get('/api/health');
      clear(health).append(
        h('dt', null, 'Status'), h('dd', null, badge('running', 'up')),
        h('dt', null, 'Uptime'), h('dd', null, `${Math.floor(result.uptimeSeconds / 3600)}h ${Math.floor((result.uptimeSeconds % 3600) / 60)}m`),
        h('dt', null, 'Mode'), h('dd', null, meta.dashboard.readOnly ? badge('read-only', 'warn') : badge('read & write', 'accent'), ' ', meta.dashboard.offline ? badge('offline', 'warn') : badge('online', 'up')),
        h('dt', null, 'Open pages'), h('dd', null, String(result.events.clients)),
        h('dt', null, 'Live tickers'), h('dd', null, String(result.events.feeds)),
        h('dt', null, 'Jobs running'), h('dd', null, String(result.jobsRunning)),
        h('dt', null, 'Cached answers'), h('dd', null, String(result.cacheEntries)),
        h('dt', null, 'Address'), h('dd', { class: 'mono' }, location.origin));
    } catch (error) { clear(health).append(h('dt', null, 'Status'), h('dd', null, badge(error.message, 'down'))); }
  }
  ctx.onRefresh(load);
  await load();
}

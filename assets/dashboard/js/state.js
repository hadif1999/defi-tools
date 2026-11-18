// Dashboard state kept per viewer in this browser: the wallet selection, chain filter, theme, auto-refresh, watchlist
// and table preferences. Storage can be blocked (private windows); everything still works from memory then.

const PREFIX = 'defi-tool:dashboard:';

function load(key, fallback) {
  try { const value = localStorage.getItem(PREFIX + key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage blocked */ }
}

const listeners = new Set();

export const state = {
  /** { mode: 'default' | 'all' | 'pick', names: string[], addresses: string[] } */
  wallets: load('wallets', { mode: 'default', names: [], addresses: [] }),
  /** Chain slugs; empty = every network. */
  chains: load('chains', []),
  autoRefresh: load('autoRefresh', true),
  collapsed: load('collapsed', false),
  /** Live tickers on the markets page: [{ pair, chain, fee, dex, protocol, quote }] */
  watchlist: load('watchlist', [
    { pair: 'WETH/USDC', chain: 'base', fee: '0.05' },
    { pair: 'cbBTC/USDC', chain: 'base' },
    { pair: 'WETH/USDC', chain: 'arb', fee: '0.05' },
  ]),
  marketPairs: load('marketPairs', 'ETH,BTC'),
  tables: load('tables', {}),
  forms: load('forms', {}),
};

export function update(key, value) {
  state[key] = value;
  save(key, value);
  for (const listener of listeners) listener(key, value);
}

/** Save a value changed in place, without telling listeners (no re-render). */
export function persist(key) { save(key, state[key]); }

export function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** Remembered form values (per form), so a page opens with what was last searched. */
export function formValues(name, defaults) { return { ...defaults, ...(state.forms[name] ?? {}) }; }
export function rememberForm(name, values) { update('forms', { ...state.forms, [name]: values }); }

export function tablePrefs(name) { return state.tables[name] ?? {}; }
export function saveTablePrefs(name, prefs) { update('tables', { ...state.tables, [name]: { ...tablePrefs(name), ...prefs } }); }

export function resetAll() {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key); } catch { /* blocked */ }
}

/** The wallet selection as API parameters (wallet=…&walletAddr=…), or none for the default wallet. */
export function walletParams() {
  const { mode, names, addresses } = state.wallets;
  if (mode === 'all') return { wallet: 'all' };
  if (mode === 'pick') return { wallet: names.length ? names.join(',') : undefined, walletAddr: addresses.length ? addresses.join(',') : undefined };
  return {};
}

export function chainParam() { return state.chains.length ? state.chains.join(',') : undefined; }

/** The --wallet/--wallet-addr/--chain flags of the current selection, for "equivalent CLI" hints. */
export function selectionFlags({ chains = true } = {}) {
  const params = walletParams();
  const flags = [];
  if (params.wallet) flags.push(`--wallet ${params.wallet}`);
  if (params.walletAddr) flags.push(`--wallet-addr ${params.walletAddr}`);
  if (chains && chainParam()) flags.push(`--chain ${chainParam()}`);
  return flags.join(' ');
}

/** Keep the dashboard's theme in the chart and position report frames (same origin, their own storage keys). */
export function shareTheme(theme) {
  try {
    localStorage.setItem('position-report-theme', theme);
    const settings = JSON.parse(localStorage.getItem('defi-tool:chart:settings') ?? '{}');
    localStorage.setItem('defi-tool:chart:settings', JSON.stringify({ ...settings, theme }));
  } catch { /* storage blocked */ }
}

export function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  return set ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(PREFIX + 'theme', theme); } catch { /* blocked */ }
  shareTheme(theme);
  for (const listener of listeners) listener('theme', theme);
}

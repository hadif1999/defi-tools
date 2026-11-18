import { h, icon, clear } from './dom.js';
import { api } from './api.js';
import { events } from './events.js';
import { state, update, setTheme, currentTheme, shareTheme, chainParam } from './state.js';
import { toast, modal, modalOpen, popover, badge } from './ui.js';
import { short } from './format.js';

// The app shell: navigation, the top bar (wallet selection, networks, auto-refresh, theme, command palette), the hash
// router and auto-refresh. Each page is a module in views/ exporting render(root, ctx).

const ROUTES = [
  { path: 'overview', label: 'Overview', icon: 'overview', group: 'Monitor', key: 'o' },
  { path: 'positions', label: 'Positions', icon: 'positions', group: 'Monitor', key: 'p' },
  { path: 'markets', label: 'Markets', icon: 'markets', group: 'Monitor', key: 'm' },
  { path: 'alerts', label: 'Alerts', icon: 'alerts', group: 'Monitor', key: 'a' },
  { path: 'pools', label: 'Pools', icon: 'pools', group: 'Explore', key: 'l' },
  { path: 'plan', label: 'Plan position', icon: 'plan', group: 'Explore', key: 'n' },
  { path: 'wallets', label: 'Wallets', icon: 'wallets', group: 'Manage', key: 'w' },
  { path: 'data', label: 'Data', icon: 'data', group: 'Manage', key: 'd' },
  { path: 'settings', label: 'Settings', icon: 'settings', group: 'Manage', key: 's' },
];
// Pages reached from others, not in the navigation.
const HIDDEN = { position: 'positions', chart: 'markets', history: 'wallets' };

const shell = document.getElementById('shell');
const main = document.getElementById('main');
const top = document.getElementById('top');
const nav = document.getElementById('nav');

const app = {
  meta: undefined,
  wallets: [],
  route: undefined,
  cleanup: undefined,
  refreshHandler: undefined,
  lastRefresh: Date.now(),
  alertCount: 0,
};

// ---------- routing
export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, search = ''] = raw.split('?');
  return { path: path || 'overview', params: Object.fromEntries(new URLSearchParams(search)) };
}

export function navigate(path, params = {}) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString();
  const next = `#/${path}${search ? `?${search}` : ''}`;
  if (location.hash === next) render();
  else location.hash = next;
}

/** Replace the current URL's parameters without re-rendering (a page's own form state). */
export function replaceParams(params) {
  const { path } = parseHash();
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false)).toString();
  history.replaceState(null, '', `#/${path}${search ? `?${search}` : ''}`);
}

async function render() {
  const { path, params } = parseHash();
  const name = ROUTES.some((route) => route.path === path) || HIDDEN[path] ? path : 'overview';
  app.cleanup?.();
  app.cleanup = undefined;
  app.refreshHandler = undefined;
  events.watch([]);
  app.route = name;
  for (const link of nav.querySelectorAll('a')) link.setAttribute('aria-current', link.dataset.path === (HIDDEN[name] ?? name) ? 'page' : 'false');
  shell.classList.remove('nav-open');
  const root = h('div', { class: 'view' });
  clear(main).append(root);
  main.scrollTop = 0;
  const route = ROUTES.find((item) => item.path === (HIDDEN[name] ?? name));
  setTitle(route?.label ?? '');
  try {
    const view = await import(`./views/${name}.js`);
    if (app.route !== name) return;
    const result = await view.render(root, context(params));
    if (typeof result === 'function') app.cleanup = result;
  } catch (error) {
    console.error(error);
    root.append(h('div', { class: 'note error' }, icon('error'), h('div', null, h('b', null, 'This page failed to load. '), error.message)));
  }
  app.lastRefresh = Date.now();
}

function context(params) {
  return {
    meta: app.meta, params, navigate, replaceParams, setTitle,
    wallets: () => app.wallets,
    reloadWallets,
    /** The page's refresh: called by auto-refresh, the refresh button, and wallet or network changes. */
    onRefresh: (handler) => { app.refreshHandler = handler; },
    readOnly: app.meta.dashboard.readOnly,
    offline: app.meta.dashboard.offline,
    updateAlerts: loadAlertCount,
  };
}

function setTitle(text) {
  const title = top.querySelector('.title');
  if (title) title.textContent = text;
  document.title = text ? `${text} · defi-tool` : 'defi-tool dashboard';
}

// ---------- navigation
function drawNav() {
  clear(nav);
  let group;
  for (const route of ROUTES) {
    if (route.group !== group) { group = route.group; nav.append(h('h6', null, group)); }
    nav.append(h('a', { href: `#/${route.path}`, dataset: { path: route.path }, title: `${route.label} (g then ${route.key})` }, icon(route.icon), h('span', null, route.label),
      route.path === 'alerts' && app.alertCount ? badge(String(app.alertCount), 'count') : null));
  }
}

// ---------- top bar
function walletLabel() {
  const { mode, names, addresses } = state.wallets;
  if (mode === 'all') return 'All wallets';
  if (mode === 'pick') {
    const items = [...names, ...addresses.map(short)];
    return items.length ? (items.length > 2 ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` : items.join(', ')) : 'No wallet';
  }
  const fallback = app.meta?.defaultWallet;
  return fallback ? `Default · ${fallback.name}` : 'Default wallet';
}

function chainLabel() {
  if (!state.chains.length) return 'All networks';
  const names = state.chains.map((slug) => app.meta.chains.find((chain) => chain.slug === slug)?.name ?? slug);
  return names.length > 2 ? `${names.length} networks` : names.join(', ');
}

function drawTop() {
  clear(top);
  const walletButton = h('button', { class: 'btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Wallets the pages read', onclick: () => openWalletPicker(walletButton) }, icon('wallets'), h('span', { class: 'text' }, walletLabel()));
  const chainButton = h('button', { class: 'btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Networks', onclick: () => openChainPicker(chainButton) }, icon('pools'), h('span', { class: 'text' }, chainLabel()));
  const ring = h('span', { class: 'countdown', title: 'Auto-refresh' });
  const refresh = h('button', { class: 'btn icon', id: 'refresh-button', title: 'Refresh (r)', 'aria-label': 'Refresh', onclick: () => refreshNow(true) }, icon('refresh'));
  const auto = h('button', { class: 'btn sm hide-sm', 'aria-pressed': String(state.autoRefresh), title: 'Refresh this page automatically', onclick: () => { update('autoRefresh', !state.autoRefresh); drawTop(); } },
    state.autoRefresh ? 'Auto' : 'Manual');
  const theme = h('button', { class: 'btn icon', title: 'Light or dark theme (t)', 'aria-label': 'Toggle theme', onclick: toggleTheme }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
  const palette = h('button', { class: 'btn hide-sm', title: 'Command palette', onclick: openPalette }, icon('search'), h('span', { class: 'muted' }, 'Search'), h('span', { class: 'kbd' }, 'Ctrl K'));
  top.append(...[
    h('button', { class: 'btn ghost icon menu-toggle', 'aria-label': 'Menu', onclick: () => shell.classList.toggle('nav-open') }, icon('menu')),
    h('button', { class: 'btn ghost icon collapse-toggle', 'aria-label': 'Collapse navigation', title: 'Collapse navigation', onclick: () => { update('collapsed', !state.collapsed); shell.classList.toggle('collapsed', state.collapsed); drawTop(); } }, icon(state.collapsed ? 'expand' : 'collapse')),
    h('div', { class: 'title' }),
    h('span', { class: 'grow' }),
    app.meta.dashboard.readOnly && badge('read-only', 'warn'),
    app.meta.dashboard.offline && badge('offline', 'warn'),
    h('div', { class: 'picker' }, walletButton),
    h('div', { class: 'picker hide-sm' }, chainButton),
    palette, auto, h('span', { style: { position: 'relative', display: 'inline-flex' } }, refresh, ring), theme,
  ].filter(Boolean));
  ring.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  drawRing(ring);
  setTitle(ROUTES.find((route) => route.path === (HIDDEN[app.route] ?? app.route))?.label ?? '');
}

function drawRing(ring) {
  ring.innerHTML = '';
  if (!state.autoRefresh) return;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', '34'); svg.setAttribute('height', '34');
  const circle = document.createElementNS(svgNs, 'circle');
  for (const [key, value] of Object.entries({ cx: 18, cy: 18, r: 16, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-dasharray': '100.5', 'stroke-linecap': 'round', opacity: '0.55', transform: 'rotate(-90 18 18)' })) circle.setAttribute(key, String(value));
  svg.append(circle);
  ring.append(svg);
  ring._circle = circle;
}

function openWalletPicker(anchor) {
  if (anchor.getAttribute('aria-expanded') === 'true') return;
  const draft = { mode: state.wallets.mode, names: [...state.wallets.names], addresses: [...state.wallets.addresses] };
  const evm = app.wallets.filter((wallet) => wallet.type === 'evm');
  const content = h('div', { style: { display: 'grid', gap: '2px' } });
  let pop;
  const apply = () => {
    update('wallets', draft.mode === 'pick' && !draft.names.length && !draft.addresses.length ? { mode: 'default', names: [], addresses: [] } : draft);
    drawTop();
    refreshNow(false);
  };
  const drawContent = () => {
    clear(content);
    const radio = (mode, label, meta) => h('label', { class: 'option' }, h('input', { type: 'radio', name: 'wallet-mode', checked: draft.mode === mode, onchange: () => { draft.mode = mode; drawContent(); } }), h('span', null, label), meta && h('span', { class: 'meta' }, meta));
    content.append(
      h('h6', null, 'Read positions of'),
      radio('default', 'Default wallet', app.meta.defaultWallet ? `${app.meta.defaultWallet.name}${app.meta.defaultWallet.chosen ? '' : ' (latest)'}` : 'none saved'),
      radio('all', 'All saved wallets', `${app.wallets.length} saved`),
      radio('pick', 'Choose…'),
    );
    if (draft.mode === 'pick') {
      content.append(h('div', { class: 'sep' }));
      if (!app.wallets.length) content.append(h('div', { class: 'option muted' }, 'No saved wallets yet.'));
      for (const wallet of app.wallets) {
        const checked = draft.names.includes(wallet.name);
        content.append(h('label', { class: 'option', title: wallet.address }, h('input', { type: 'checkbox', checked, disabled: wallet.type !== 'evm', onchange: (event) => {
          draft.names = event.target.checked ? [...draft.names, wallet.name] : draft.names.filter((name) => name !== wallet.name);
        } }), h('span', null, wallet.name), wallet.default && badge('★', 'accent'), h('span', { class: 'meta' }, wallet.type === 'evm' ? short(wallet.address) : 'Solana (no positions)')));
      }
      const addressInput = h('input', { class: 'input', placeholder: '0x… any address', style: { height: '32px' }, 'aria-label': 'Add an address' });
      const addAddress = () => {
        const value = addressInput.value.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(value)) { toast('Enter a 0x address with 40 hexadecimal characters.', { kind: 'error' }); return; }
        if (!draft.addresses.includes(value)) draft.addresses.push(value);
        drawContent();
      };
      addressInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addAddress(); } });
      content.append(h('div', { class: 'row' }, addressInput, h('button', { class: 'btn sm', onclick: addAddress }, 'Add')));
      if (draft.addresses.length) content.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } }, draft.addresses.map((address) => h('span', { class: 'chip' }, short(address), h('button', { 'aria-label': `Remove ${address}`, onclick: () => { draft.addresses = draft.addresses.filter((item) => item !== address); drawContent(); } }, icon('close'))))));
      if (evm.length === 0 && app.wallets.length) content.append(h('div', { class: 'option muted' }, 'Positions are read for EVM wallets only.'));
    }
    content.append(h('div', { class: 'sep' }), h('div', { class: 'row' }, h('a', { class: 'btn sm ghost', href: '#/wallets', onclick: () => pop.close() }, icon('wallets'), 'Manage wallets'), h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn sm primary', onclick: () => { pop.close(); apply(); } }, 'Apply')));
  };
  drawContent();
  pop = popover(anchor, content);
}

function openChainPicker(anchor) {
  if (anchor.getAttribute('aria-expanded') === 'true') return;
  let draft = [...state.chains];
  const content = h('div', { style: { display: 'grid', gap: '2px' } });
  let pop;
  const drawContent = () => {
    clear(content);
    content.append(h('h6', null, 'Networks'), h('label', { class: 'option' }, h('input', { type: 'checkbox', checked: !draft.length, onchange: () => { draft = []; drawContent(); } }), h('span', null, 'All networks')));
    for (const chain of app.meta.chains) {
      content.append(h('label', { class: 'option' }, h('input', { type: 'checkbox', checked: draft.includes(chain.slug), onchange: (event) => {
        draft = event.target.checked ? [...draft, chain.slug] : draft.filter((slug) => slug !== chain.slug);
        drawContent();
      } }), h('span', null, chain.name), h('span', { class: 'meta' }, chain.evm ? chain.slug : 'pools only')));
    }
    content.append(h('div', { class: 'sep' }), h('div', { class: 'row' }, h('span', { style: { flex: 1 } }), h('button', { class: 'btn sm primary', onclick: () => { pop.close(); update('chains', draft); drawTop(); refreshNow(false); } }, 'Apply')));
  };
  drawContent();
  pop = popover(anchor, content);
}

function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  drawTop();
  // Frames (chart workspace, position report) read the theme when they load.
  for (const frame of document.querySelectorAll('iframe.frame')) { try { frame.contentWindow.location.reload(); } catch { /* not loaded yet */ } }
}

// ---------- refresh
async function refreshNow(force) {
  const button = document.getElementById('refresh-button');
  button?.classList.add('spin');
  try {
    app.lastRefresh = Date.now();
    if (app.refreshHandler) await app.refreshHandler({ force });
    else await render();
    void loadAlertCount();
  } finally { button?.classList.remove('spin'); }
}

function tickRefresh() {
  const circle = document.querySelector('.countdown')?._circle;
  const period = app.meta?.dashboard.refreshMs ?? 60_000;
  const elapsed = Date.now() - app.lastRefresh;
  if (circle) circle.setAttribute('stroke-dashoffset', String(100.5 * Math.min(1, elapsed / period)));
  if (state.autoRefresh && elapsed >= period && document.visibilityState === 'visible' && !modalOpen() && app.refreshHandler) void refreshNow(false);
}

async function reloadWallets() {
  try {
    const [wallets, meta] = await Promise.all([api.get('/api/wallets'), api.get('/api/meta')]);
    app.wallets = wallets.data;
    app.meta = meta.data;
    // Drop wallets that no longer exist from the selection.
    if (state.wallets.mode === 'pick') {
      const names = state.wallets.names.filter((name) => app.wallets.some((wallet) => wallet.name.toLowerCase() === name.toLowerCase()));
      if (names.length !== state.wallets.names.length) update('wallets', { ...state.wallets, names });
    }
    drawTop();
  } catch (error) { console.warn(error); }
}

async function loadAlertCount() {
  try {
    const result = await api.get('/api/alerts', { limit: 500 });
    const count = result.data.filter((alert) => !alert.acknowledged).length;
    if (count !== app.alertCount) { app.alertCount = count; drawNav(); for (const link of nav.querySelectorAll('a')) link.setAttribute('aria-current', link.dataset.path === (HIDDEN[app.route] ?? app.route) ? 'page' : 'false'); }
  } catch { /* shown on the alerts page */ }
}

// ---------- command palette
function openPalette() {
  if (document.querySelector('.palette')) return;
  const items = [
    ...ROUTES.map((route) => ({ label: `Go to ${route.label}`, meta: `g ${route.key}`, icon: route.icon, run: () => navigate(route.path) })),
    ...app.wallets.map((wallet) => ({ label: `Show positions of ${wallet.name}`, meta: short(wallet.address), icon: 'wallets', run: () => { update('wallets', { mode: 'pick', names: [wallet.name], addresses: [] }); drawTop(); navigate('positions'); } })),
    ...app.wallets.map((wallet) => ({ label: `History of ${wallet.name}`, meta: wallet.chainName, icon: 'history', run: () => navigate('history', { wallet: wallet.name }) })),
    { label: 'Read all saved wallets', icon: 'wallets', run: () => { update('wallets', { mode: 'all', names: [], addresses: [] }); drawTop(); refreshNow(false); } },
    { label: 'Use the default wallet', icon: 'star', run: () => { update('wallets', { mode: 'default', names: [], addresses: [] }); drawTop(); refreshNow(false); } },
    { label: 'Add a wallet', icon: 'plus', run: () => navigate('wallets', { add: 1 }) },
    { label: 'Run an alert check', icon: 'alerts', run: () => navigate('alerts', { run: 1 }) },
    { label: 'Download candles', icon: 'download', run: () => navigate('data') },
    { label: 'Toggle theme', meta: 't', icon: 'moon', run: toggleTheme },
    { label: 'Refresh this page', meta: 'r', icon: 'refresh', run: () => refreshNow(true) },
    { label: 'Keyboard shortcuts', meta: '?', icon: 'info', run: showShortcuts },
  ];
  const inputNode = h('input', { placeholder: 'Type a page, wallet or action…', 'aria-label': 'Command', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' });
  const list = h('ul', { id: 'palette-list', role: 'listbox' });
  let selected = 0;
  let shown = items;
  const close = () => { backdrop.remove(); };
  const drawList = () => {
    clear(list);
    if (!shown.length) { list.append(h('li', { class: 'empty' }, 'No matches')); return; }
    shown.slice(0, 40).forEach((item, index) => list.append(h('li', { role: 'option', 'aria-selected': String(index === selected), onmousemove: () => { if (selected !== index) { selected = index; drawList(); } }, onclick: () => { close(); item.run(); } },
      icon(item.icon), h('span', null, item.label), item.meta && h('span', { class: 'meta' }, item.meta))));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  inputNode.addEventListener('input', () => {
    const words = inputNode.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter((item) => words.every((word) => `${item.label} ${item.meta ?? ''}`.toLowerCase().includes(word)));
    selected = 0;
    drawList();
  });
  inputNode.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, shown.length - 1); drawList(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); drawList(); }
    else if (event.key === 'Enter') { event.preventDefault(); const item = shown[selected]; if (item) { close(); item.run(); } }
    else if (event.key === 'Escape') close();
  });
  const backdrop = h('div', { class: 'backdrop', onmousedown: (event) => { if (event.target === backdrop) close(); } }, h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, inputNode, list));
  document.body.append(backdrop);
  drawList();
  inputNode.focus();
}

function showShortcuts() {
  const rows = [['Ctrl K', 'Command palette'], ['r', 'Refresh this page'], ['t', 'Toggle theme'], ['?', 'This help'], ...ROUTES.map((route) => [`g ${route.key}`, route.label])];
  modal({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv' }, rows.flatMap(([key, label]) => [h('dt', null, h('span', { class: 'kbd' }, key)), h('dd', null, label)])), actions: [{ label: 'Close', kind: 'primary' }] });
}

let pendingG = 0;
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); return; }
  const typing = event.target.closest?.('input, textarea, select, [contenteditable]');
  if (typing || event.ctrlKey || event.metaKey || event.altKey || modalOpen() || document.querySelector('.palette')) return;
  if (pendingG && Date.now() - pendingG < 1200) {
    const route = ROUTES.find((item) => item.key === event.key);
    pendingG = 0;
    if (route) { event.preventDefault(); navigate(route.path); }
    return;
  }
  if (event.key === 'g') pendingG = Date.now();
  else if (event.key === 'r') { event.preventDefault(); void refreshNow(true); }
  else if (event.key === 't') toggleTheme();
  else if (event.key === '?') showShortcuts();
});

// ---------- start
function locked() {
  clear(document.body).append(h('main', { style: { display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '24px' } }, h('div', { class: 'card', style: { maxWidth: '520px', padding: '28px' } },
    h('h2', { style: { marginTop: 0, display: 'flex', gap: '10px', alignItems: 'center' } }, icon('lock'), 'Session ended'),
    h('p', null, 'This dashboard needs its access token again: the server was restarted with a new one, or the session cookie was cleared.'),
    h('p', { class: 'muted' }, 'Open the link defi-tool dashboard serve printed in your terminal.'))));
}

async function start() {
  window.addEventListener('dashboard:locked', locked, { once: true });
  shell.classList.toggle('collapsed', state.collapsed);
  shareTheme(currentTheme());
  try {
    const [meta, wallets] = await Promise.all([api.get('/api/meta'), api.get('/api/wallets')]);
    app.meta = meta.data;
    app.wallets = wallets.data;
  } catch (error) {
    if (error.status === 401) return;
    clear(main).append(h('div', { class: 'view' }, h('div', { class: 'note error' }, icon('error'), h('div', null, h('b', null, 'The dashboard could not start. '), error.message))));
    return;
  }
  // Networks saved in the selection that this server does not know are dropped.
  if (state.chains.some((slug) => !app.meta.chains.some((chain) => chain.slug === slug))) update('chains', state.chains.filter((slug) => app.meta.chains.some((chain) => chain.slug === slug)));
  drawNav();
  drawTop();
  events.start();
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  events.onStatus((status) => {
    dot.className = `dot ${status === 'live' ? 'ok' : status === 'closed' ? 'bad' : 'wait'}`;
    text.textContent = status === 'live' ? `Live · ${location.host}` : status === 'closed' ? 'Disconnected' : 'Reconnecting…';
  });
  events.on('job', (job) => {
    if (job.status === 'done') toast(job.label, { kind: 'ok', title: 'Job finished' });
    if (job.status === 'failed') toast(job.error ?? 'Failed', { kind: 'error', title: job.label });
    if (job.kind === 'alerts-check' && job.status !== 'running') void loadAlertCount();
  });
  events.on('wallets', () => { void reloadWallets(); });
  events.on('notice', (notice) => toast(notice.message, { kind: 'info' }));
  window.addEventListener('hashchange', render);
  setInterval(tickRefresh, 1000);
  void loadAlertCount();
  await render();
}

void start();

export { app, chainParam };

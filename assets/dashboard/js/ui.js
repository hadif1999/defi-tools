import { h, s, icon, clear, copyText, append } from './dom.js';
import { tokenColor, MISSING, num } from './format.js';
import { saveTablePrefs, tablePrefs } from './state.js';

// Shared components: toasts, modals, confirm, the data table, KPI tiles, donut, sparkline, range bar, notes, CLI hints.

// ---------- toasts
export function toast(message, { kind = 'info', title, timeout = kind === 'error' ? 8000 : 4000 } = {}) {
  const box = document.getElementById('toasts');
  const close = h('button', { class: 'btn ghost sm icon', 'aria-label': 'Dismiss', onclick: () => node.remove() }, icon('close'));
  const node = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'ok' ? 'check' : kind === 'error' ? 'error' : 'info'), h('div', { class: 'grow' }, title && h('b', null, title), message), close);
  box.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

// ---------- modals
let openModals = 0;
export function modal({ title, body, actions = [], width, onClose }) {
  const previous = document.activeElement;
  const close = () => { backdrop.remove(); openModals -= 1; document.removeEventListener('keydown', onKey, true); previous?.focus?.(); onClose?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width: `min(${width}px, 100%)` } : undefined },
    h('header', null, h('h3', null, title), h('span', { class: 'grow' }), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: close }, icon('close'))),
    h('div', { class: 'body' }, body),
    actions.length ? h('footer', null, actions.map((action) => h('button', {
      class: `btn ${action.kind ?? ''}`, type: action.submit ? 'submit' : 'button', onclick: async (event) => {
        const button = event.currentTarget;
        if (action.run) {
          button.disabled = true;
          try { const keep = await action.run(); if (keep !== false) close(); } finally { button.disabled = false; }
        } else close();
      },
    }, action.label))) : null);
  const backdrop = h('div', { class: 'backdrop', onmousedown: (event) => { if (event.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  openModals += 1;
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => (dialog.querySelector('input, select, textarea, button.primary') ?? dialog).focus());
  return { close, dialog };
}
export const modalOpen = () => openModals > 0;

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title, body: h('p', { style: { margin: 0 } }, message), onClose: () => { if (!answered) resolve(false); },
      actions: [{ label: 'Cancel' }, { label: confirm, kind: danger ? 'danger solid' : 'primary', run: () => { answered = true; resolve(true); } }],
    });
  });
}

// ---------- form fields
export function field(label, control, { hint, id, error } = {}) {
  const fieldId = id ?? control.id ?? `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = fieldId;
  const errorNode = h('div', { class: 'error', hidden: !error, id: `${fieldId}-error` }, error);
  const node = h('div', { class: 'field' }, h('label', { for: fieldId }, label), control, hint && h('div', { class: 'hint' }, hint), errorNode);
  node.setError = (message) => {
    errorNode.textContent = message ?? '';
    errorNode.hidden = !message;
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) control.setAttribute('aria-describedby', errorNode.id);
  };
  return node;
}
export const input = (attrs) => h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', ...attrs });
export function select(options, attrs = {}) {
  return h('select', { class: 'input', ...attrs }, options.map((option) => {
    const [value, label] = Array.isArray(option) ? option : [option, option];
    return h('option', { value, selected: String(attrs.value ?? '') === String(value) }, label);
  }));
}
export function segmented(options, value, onChange, { label } = {}) {
  const node = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const draw = (current) => {
    clear(node);
    for (const option of options) {
      const [key, text] = Array.isArray(option) ? option : [option, option];
      node.append(h('button', { type: 'button', 'aria-pressed': String(key === current), onclick: () => { draw(key); onChange(key); } }, text));
    }
  };
  draw(value);
  return node;
}

// ---------- notes and states
export function notesBanner(notes = [], { kind = 'warn' } = {}) {
  const items = [...new Set(notes.filter(Boolean))];
  if (!items.length) return null;
  return h('div', { class: 'notes' }, items.map((text) => {
    const node = h('div', { class: `note ${kind}` }, icon(kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'warn'), h('div', { class: 'grow' }, text),
      h('button', { 'aria-label': 'Dismiss', onclick: () => node.remove() }, icon('close')));
    return node;
  }));
}
export function errorBox(error, retry) {
  return h('div', { class: 'note error' }, icon('error'), h('div', { class: 'grow' }, h('b', null, error.status === 0 ? 'Server unreachable' : 'Could not load'), h('div', null, error.message)),
    retry && h('button', { class: 'btn sm', onclick: retry }, icon('refresh'), 'Retry'));
}
export function emptyState(title, text, { iconName = 'info', action } = {}) {
  return h('div', { class: 'empty-state' }, icon(iconName), h('b', null, title), text && h('div', null, text), action);
}
export function skeleton(rows = 4, height = 18) {
  return h('div', { style: { display: 'grid', gap: '10px', padding: '12px 16px' } }, Array.from({ length: rows }, (_, i) => h('span', { class: 'skeleton', style: { height: `${height}px`, width: `${100 - (i % 3) * 12}%` } })));
}
export function cliHint(command) {
  const code = h('code', { title: command }, command);
  return h('div', { class: 'cli', 'aria-label': 'Equivalent CLI command' }, h('span', { class: 'prompt' }, '$'), code,
    h('button', { class: 'btn ghost sm icon', title: 'Copy command', 'aria-label': 'Copy command', onclick: async () => { if (await copyText(command)) toast('Command copied.', { kind: 'ok', timeout: 1800 }); } }, icon('copy')));
}
export function card(title, body, { sub, actions, flush = false, id } = {}) {
  return h('section', { class: 'card', id }, (title || actions) && h('header', null, title && h('h2', null, title), sub && h('span', { class: 'sub' }, sub), h('span', { class: 'grow' }), actions),
    h('div', { class: `body${flush ? ' flush' : ''}` }, body));
}
export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
export function copyButton(text, label = 'Copy') {
  return h('button', { class: 'btn ghost sm icon', title: label, 'aria-label': label, onclick: async (event) => { event.stopPropagation(); if (await copyText(text)) toast('Copied.', { kind: 'ok', timeout: 1500 }); } }, icon('copy'));
}

// ---------- tokens and pairs
export function tokenBubble(symbol) {
  const text = String(symbol ?? '?').replace(/^W(?=ETH|BTC|SOL|BNB|MATIC|POL)/, '').slice(0, 4);
  return h('span', { class: 'token', style: { background: tokenColor(symbol) }, title: symbol }, text.length > 3 ? text.slice(0, 3) : text);
}
export function pairCell(symbols, sub) {
  return h('div', { class: 'pair' }, h('span', { class: 'tokens' }, symbols.slice(0, 3).map(tokenBubble)), h('div', null, h('b', null, symbols.join('/')), sub && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub)));
}

// ---------- KPI tile
export function kpi(label, value, { foot, tone, kind, spark, title } = {}) {
  return h('div', { class: `kpi ${kind ?? ''}`, title }, h('div', { class: 'label' }, label), h('div', { class: `value ${tone ?? ''}` }, value), foot && h('div', { class: 'foot' }, foot), spark && h('div', { class: 'spark' }, spark));
}

// ---------- charts (SVG)
const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
export const seriesColor = (index) => `var(${PALETTE[index % PALETTE.length]})`;

export function donut(items, { size = 140, thickness = 22, label, sub } = {}) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': label ?? 'Breakdown' });
  svg.append(s('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'var(--line)', 'stroke-width': thickness }));
  let offset = 0;
  items.forEach((item, index) => {
    if (!total || item.value <= 0) return;
    const length = (item.value / total) * circumference;
    const arc = s('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: seriesColor(index), 'stroke-width': thickness, 'stroke-dasharray': `${Math.max(0, length - 1.5)} ${circumference}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${size / 2} ${size / 2})` });
    arc.append(s('title', null, `${item.label}: ${item.display ?? item.value}`));
    svg.append(arc);
    offset += length;
  });
  if (label) svg.append(s('text', { x: '50%', y: '47%', 'text-anchor': 'middle', 'font-size': '15', 'font-weight': '700', fill: 'var(--text)' }, label));
  if (sub) svg.append(s('text', { x: '50%', y: '62%', 'text-anchor': 'middle', 'font-size': '10.5', fill: 'var(--muted)' }, sub));
  return svg;
}

export function legend(items, format) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return h('div', { class: 'legend' }, items.map((item, index) => h('div', { class: 'item' }, h('span', { class: 'swatch', style: { background: seriesColor(index) } }), h('span', null, item.label),
    h('span', { class: 'v' }, `${format ? format(item.value) : item.value}${total ? ` · ${((item.value / total) * 100).toFixed(0)}%` : ''}`))));
}

export function sparkline(values, { width = 90, height = 28, color } = {}) {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const path = points.map((value, index) => `${index ? 'L' : 'M'}${(index * step).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  const stroke = color ?? (points.at(-1) >= points[0] ? 'var(--up)' : 'var(--down)');
  return s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
    s('path', { d: `${path} L${width},${height} L0,${height} Z`, fill: stroke, opacity: '0.08' }),
    s('path', { d: path, fill: 'none', stroke, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

/** Where the price sits in a position's range, on a log scale, with the limits under it. */
export function rangeBar(lower, upper, price, { invert = false } = {}) {
  if (!(lower > 0) || !(upper > 0)) return h('span', { class: 'muted' }, MISSING);
  let [lo, hi, p] = invert ? [1 / upper, 1 / lower, price ? 1 / price : undefined] : [lower, upper, price];
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const pad = (logHi - logLo) * 0.35 || 0.1;
  const min = Math.min(logLo - pad, p ? Math.log(p) - pad * 0.3 : Infinity);
  const max = Math.max(logHi + pad, p ? Math.log(p) + pad * 0.3 : -Infinity);
  const at = (value) => `${(((Math.log(value) - min) / (max - min)) * 100).toFixed(1)}%`;
  const inRange = p !== undefined && p >= lo && p <= hi;
  return h('div', { class: `range ${p !== undefined && !inRange ? 'out' : ''}`, title: `${num(lo)} – ${num(hi)}${p ? ` · now ${num(p)}` : ''}` },
    h('div', { class: 'bar' }, h('span', { class: 'band', style: { left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` } }), p && h('span', { class: 'mark', style: { left: at(p) } })),
    h('div', { class: 'labels' }, h('span', null, num(lo)), h('span', null, num(hi))));
}

// ---------- data table
/**
 * columns: [{ key, label, align, sort: row => value, render: row => node|string, csv: row => value, hidden, title }]
 * Saves the sort and hidden columns per table name. Rows are paged with "show more".
 */
export function dataTable({ name, columns, rows, onRow, empty, search, pageSize = 50, toolbar, rowClass, exportName }) {
  const prefs = tablePrefs(name);
  let sortKey = prefs.sort?.key;
  let sortDir = prefs.sort?.dir ?? 'desc';
  const hidden = new Set(prefs.hidden ?? columns.filter((column) => column.hidden).map((column) => column.key));
  let filter = '';
  let limit = pageSize;
  const wrap = h('div', { class: 'table-wrap' });
  const foot = h('div', { class: 't-foot' });
  const searchInput = search && h('input', { class: 'input', type: 'search', placeholder: 'Filter rows…', style: { height: '30px', width: '200px' }, 'aria-label': 'Filter rows', oninput: (event) => { filter = event.target.value.toLowerCase(); limit = pageSize; draw(); } });
  const columnsButton = h('button', { class: 'btn sm', title: 'Columns', onclick: (event) => toggleColumns(event.currentTarget) }, icon('columns'), 'Columns');
  const csvButton = h('button', { class: 'btn sm', title: 'Export CSV', onclick: () => exportCsv() }, icon('download'), 'CSV');
  const bar = h('div', { class: 'toolbar', style: { padding: '0 14px 10px' } }, searchInput, toolbar, h('span', { class: 'grow' }), columnsButton, csvButton);

  const visible = () => columns.filter((column) => !hidden.has(column.key));
  const sorted = () => {
    let list = rows;
    if (filter && search) list = list.filter((row) => search(row).toLowerCase().includes(filter));
    const column = columns.find((item) => item.key === sortKey);
    if (column?.sort) {
      const value = (row) => column.sort(row);
      list = [...list].sort((a, b) => {
        const x = value(a); const y = value(b);
        const missing = (v) => v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v));
        if (missing(x) && missing(y)) return 0;
        if (missing(x)) return 1;
        if (missing(y)) return -1;
        const order = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return sortDir === 'asc' ? order : -order;
      });
    }
    return list;
  };
  function draw() {
    const list = sorted();
    const cols = visible();
    clear(wrap);
    if (!rows.length) { wrap.append(empty ?? emptyState('Nothing here', 'No rows to show.')); foot.hidden = true; return; }
    const head = h('tr', null, cols.map((column) => {
      const active = column.key === sortKey;
      return h('th', {
        class: `${column.align === 'right' ? 'r' : column.align === 'center' ? 'c' : ''} ${column.sort ? 'sortable' : ''}`, title: column.title, scope: 'col',
        'aria-sort': active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined, tabindex: column.sort ? '0' : undefined,
        onclick: column.sort ? () => sortBy(column.key) : undefined, onkeydown: column.sort ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortBy(column.key); } } : undefined,
      }, column.label, column.sort && h('span', { class: 'arrow' }, active ? (sortDir === 'asc' ? '▲' : '▼') : ''));
    }));
    const body = h('tbody', null, list.slice(0, limit).map((row) => h('tr', {
      class: `${onRow ? 'click' : ''} ${rowClass?.(row) ?? ''}`, tabindex: onRow ? '0' : undefined,
      onclick: onRow ? (event) => { if (!event.target.closest('a, button, input')) onRow(row, event); } : undefined,
      onkeydown: onRow ? (event) => { if (event.key === 'Enter' && event.target === event.currentTarget) onRow(row, event); } : undefined,
    }, cols.map((column) => {
      const content = column.render ? column.render(row) : row[column.key];
      return h('td', { class: column.align === 'right' ? 'r' : column.align === 'center' ? 'c' : column.wrap ? 'wrap' : '' }, content ?? MISSING);
    }))));
    wrap.append(h('table', { class: 't' }, h('thead', null, head), body));
    clear(foot);
    foot.hidden = false;
    append(foot, [h('span', null, `${Math.min(limit, list.length)} of ${list.length}${list.length !== rows.length ? ` (filtered from ${rows.length})` : ''} rows`), h('span', { class: 'grow' }),
      list.length > limit && h('button', { class: 'btn sm', onclick: () => { limit += pageSize * 2; draw(); } }, `Show ${Math.min(pageSize * 2, list.length - limit)} more`)]);
    if (!list.length) wrap.append(emptyState('No matches', `No rows match "${filter}".`, { iconName: 'search' }));
  }
  function sortBy(key) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'desc'; }
    saveTablePrefs(name, { sort: { key: sortKey, dir: sortDir } });
    draw();
  }
  function toggleColumns(anchor) {
    document.querySelector('.popover.columns')?.remove();
    const pop = h('div', { class: 'popover columns', role: 'dialog', 'aria-label': 'Columns', style: { position: 'fixed' } }, h('h6', null, 'Columns'),
      columns.map((column) => h('label', { class: 'option' }, h('input', { type: 'checkbox', checked: !hidden.has(column.key), onchange: (event) => {
        if (event.target.checked) hidden.delete(column.key); else hidden.add(column.key);
        saveTablePrefs(name, { hidden: [...hidden] });
        draw();
      } }), column.label || column.key)));
    const rect = anchor.getBoundingClientRect();
    Object.assign(pop.style, { top: `${rect.bottom + 6}px`, left: `${Math.max(8, rect.right - 260)}px`, right: 'auto', maxHeight: '60vh', overflowY: 'auto' });
    document.body.append(pop);
    const away = (event) => { if (!pop.contains(event.target) && event.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', away); } };
    setTimeout(() => document.addEventListener('mousedown', away));
  }
  function exportCsv() {
    const cols = visible().filter((column) => column.csv || column.sort);
    const escape = (value) => { const text = value === undefined || value === null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const lines = [cols.map((column) => escape(column.label || column.key)).join(','), ...sorted().map((row) => cols.map((column) => escape((column.csv ?? column.sort)(row))).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const link = h('a', { href: url, download: `${exportName ?? name}-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  draw();
  const node = h('div', null, bar, wrap, foot);
  node.update = (next) => { rows = next; draw(); };
  return node;
}

/** A little popover anchored under a button; closes on outside click or Escape. */
export function popover(anchor, content, { align = 'right' } = {}) {
  const pop = h('div', { class: `popover ${align === 'left' ? 'left' : ''}` }, content);
  anchor.parentElement.append(pop);
  const close = () => { pop.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); anchor.setAttribute('aria-expanded', 'false'); };
  const away = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) close(); };
  const key = (event) => { if (event.key === 'Escape') { close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', key); });
  anchor.setAttribute('aria-expanded', 'true');
  return { close, node: pop };
}

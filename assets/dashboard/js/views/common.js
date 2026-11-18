import { h, icon, clear } from '../dom.js';
import { usd, signedUsd, pct, num, age, day, short, tone, fee, MISSING } from '../format.js';
import { badge, pairCell, rangeBar, errorBox, notesBanner, skeleton, cliHint } from '../ui.js';

// Helpers shared by the pages: price orientation and range status as positions list shows them, position table columns,
// and a loader that shows a skeleton, then the data, the server's notes, or the error with a retry.

const STABLES = new Set(['usdc', 'usdt', 'dai', 'usds', 'usde', 'usdc.e', 'usdbc', 'usdt0', 'fdusd', 'busd', 'pyusd', 'frax', 'lusd', 'gho', 'crvusd', 'tusd']);
const NATIVES = new Set(['weth', 'eth', 'wbnb', 'bnb', 'wpol', 'pol', 'wmatic', 'matic', 'sol', 'wsol']);
const BTC = new Set(['wbtc', 'cbbtc', 'btcb', 'tbtc']);
const rank = (symbol) => { const name = String(symbol).toLowerCase(); return STABLES.has(name) ? 3 : NATIVES.has(name) ? 2 : BTC.has(name) ? 1 : 0; };

/** Prices quoted in the more money-like token, as the CLI does (USDC per WETH). */
export function priceView(position) {
  const inverted = rank(position.token0.symbol) > rank(position.token1.symbol);
  const flip = (value) => value === undefined || value === null || value === 0 ? undefined : inverted ? 1 / value : value;
  const base = inverted ? position.token1.symbol : position.token0.symbol;
  const quote = inverted ? position.token0.symbol : position.token1.symbol;
  const lower = flip(inverted ? position.priceUpper : position.priceLower);
  const upper = flip(inverted ? position.priceLower : position.priceUpper);
  return { inverted, base, quote, unit: `${quote} per ${base}`, price: flip(position.price), lower, upper, exitPrice: flip(position.exitPrice) };
}

/** In range, below or above (by how much), or unknown. */
export function rangeState(position) {
  const view = priceView(position);
  if (!position.active) return { key: 'closed', label: 'Closed', kind: '' };
  if (view.price === undefined || view.lower === undefined || view.upper === undefined) return position.inRange === true ? { key: 'in', label: 'In range', kind: 'up' } : position.inRange === false ? { key: 'out', label: 'Out of range', kind: 'down' } : { key: 'unknown', label: 'Unknown', kind: 'warn' };
  if (view.price < view.lower) return { key: 'below', label: `▼ Below ${pct(Math.abs((view.price / view.lower - 1) * 100))}`, kind: 'down' };
  if (view.price > view.upper) return { key: 'above', label: `▲ Above ${pct((view.price / view.upper - 1) * 100)}`, kind: 'down' };
  // Near a limit: within 10% of the range width (log scale).
  const span = Math.log(view.upper / view.lower) || 1;
  const toEdge = Math.min(Math.log(view.price / view.lower), Math.log(view.upper / view.price)) / span;
  return toEdge < 0.1 ? { key: 'near', label: '● Near limit', kind: 'warn' } : { key: 'in', label: '● In range', kind: 'up' };
}

export const poolName = (position) => `${position.token0.symbol}/${position.token1.symbol}`;
export const poolSub = (position, meta) => [fee(position.feeTier) !== MISSING ? fee(position.feeTier) : null, position.protocol, meta?.chains.find((chain) => chain.id === position.chainId)?.name].filter(Boolean).join(' · ');
export const walletOf = (position) => position.walletName ?? short(position.wallet);

export function balanceText(position) {
  const parts = [];
  if (position.amount0 > 0) parts.push(`${num(position.amount0)} ${position.token0.symbol}`);
  if (position.amount1 > 0) parts.push(`${num(position.amount1)} ${position.token1.symbol}`);
  return parts.join(' + ') || MISSING;
}

export function pnlCell(position) {
  if (position.pnlUsd === undefined) return h('span', { class: 'muted' }, MISSING);
  const share = position.depositedUsd ? (position.pnlUsd / position.depositedUsd) * 100 : undefined;
  return h('span', { class: tone(position.pnlUsd) }, signedUsd(position.pnlUsd), share !== undefined && h('span', { class: 'muted', style: { marginLeft: '4px', fontSize: '11.5px' } }, `(${pct(share, { sign: true })})`));
}

export function openColumns(meta, { several = true } = {}) {
  return [
    { key: 'pool', label: 'Pool', sort: (row) => poolName(row), render: (row) => pairCell([row.token0.symbol, row.token1.symbol], poolSub(row, meta)) },
    { key: 'id', label: 'ID', align: 'right', sort: (row) => Number(row.id), render: (row) => h('span', { class: 'mono' }, `#${row.id}`) },
    { key: 'wallet', label: 'Wallet', sort: walletOf, render: walletOf, hidden: !several },
    { key: 'status', label: 'Status', sort: (row) => rangeState(row).key, render: (row) => { const state = rangeState(row); return badge(state.label, state.kind); } },
    { key: 'range', label: 'Range', render: (row) => { const view = priceView(row); return rangeBar(view.lower, view.upper, view.price); }, csv: (row) => { const view = priceView(row); return `${view.lower} - ${view.upper}`; } },
    { key: 'price', label: 'Price', align: 'right', sort: (row) => priceView(row).price, render: (row) => num(priceView(row).price) },
    { key: 'unit', label: 'Unit', sort: (row) => priceView(row).unit, render: (row) => h('span', { class: 'muted' }, priceView(row).unit), hidden: true },
    { key: 'balance', label: 'Balance', sort: balanceText, render: balanceText, hidden: true },
    { key: 'value', label: 'Value', align: 'right', sort: (row) => row.valueUsd, render: (row) => h('b', null, usd(row.valueUsd)) },
    { key: 'unclaimed', label: 'Unclaimed', align: 'right', sort: (row) => row.uncollectedFeesUsd, render: (row) => usd(row.uncollectedFeesUsd) },
    { key: 'fees', label: 'Fees earned', align: 'right', sort: (row) => row.feesEarnedUsd, render: (row) => usd(row.feesEarnedUsd) },
    { key: 'apr', label: 'Fee APR', align: 'right', sort: (row) => row.feeAprPct, render: (row) => pct(row.feeAprPct) },
    { key: 'pnl', label: 'PnL', align: 'right', sort: (row) => row.pnlUsd, render: pnlCell, csv: (row) => row.pnlUsd },
    { key: 'il', label: 'IL', align: 'right', sort: (row) => row.ilUsd, render: (row) => h('span', { class: tone(row.ilUsd) }, signedUsd(row.ilUsd)), hidden: true },
    { key: 'age', label: 'Age', align: 'right', sort: (row) => row.openedAt ? -Date.parse(row.openedAt) : undefined, render: (row) => age(row.openedAt), csv: (row) => row.openedAt },
  ];
}

export function closedColumns(meta, { several = true } = {}) {
  return [
    { key: 'pool', label: 'Pool', sort: (row) => poolName(row), render: (row) => pairCell([row.token0.symbol, row.token1.symbol], poolSub(row, meta)) },
    { key: 'id', label: 'ID', align: 'right', sort: (row) => Number(row.id), render: (row) => h('span', { class: 'mono' }, `#${row.id}`) },
    { key: 'wallet', label: 'Wallet', sort: walletOf, render: walletOf, hidden: !several },
    { key: 'range', label: 'Range (min – max)', render: (row) => { const view = priceView(row); return `${num(view.lower)} – ${num(view.upper)}`; }, csv: (row) => { const view = priceView(row); return `${view.lower} - ${view.upper}`; } },
    { key: 'exit', label: 'Exit price', align: 'right', sort: (row) => priceView(row).exitPrice, render: (row) => num(priceView(row).exitPrice) },
    { key: 'now', label: 'Price now', align: 'right', sort: (row) => priceView(row).price, render: (row) => num(priceView(row).price) },
    { key: 'deposited', label: 'Deposited', align: 'right', sort: (row) => row.depositedUsd, render: (row) => usd(row.depositedUsd) },
    { key: 'withdrawn', label: 'Withdrawn', align: 'right', sort: (row) => row.withdrawnUsd, render: (row) => usd(row.withdrawnUsd) },
    { key: 'fees', label: 'Fees earned', align: 'right', sort: (row) => row.feesEarnedUsd, render: (row) => usd(row.feesEarnedUsd) },
    { key: 'gas', label: 'Gas', align: 'right', sort: (row) => row.gasUsd, render: (row) => usd(row.gasUsd) },
    { key: 'apr', label: 'Fee APR', align: 'right', sort: (row) => row.feeAprPct, render: (row) => pct(row.feeAprPct) },
    { key: 'pnl', label: 'PnL', align: 'right', sort: (row) => row.pnlUsd, render: pnlCell, csv: (row) => row.pnlUsd },
    { key: 'il', label: 'IL', align: 'right', sort: (row) => row.ilUsd, render: (row) => h('span', { class: tone(row.ilUsd) }, signedUsd(row.ilUsd)) },
    { key: 'opened', label: 'Opened', sort: (row) => row.openedAt, render: (row) => day(row.openedAt) },
    { key: 'closed', label: 'Closed', sort: (row) => row.closedAt, render: (row) => day(row.closedAt) },
    { key: 'held', label: 'Held', align: 'right', sort: (row) => row.openedAt && row.closedAt ? Date.parse(row.closedAt) - Date.parse(row.openedAt) : undefined, render: (row) => row.openedAt && row.closedAt ? age(row.openedAt, Date.parse(row.closedAt)) : MISSING },
  ];
}

export const positionSearch = (row) => `${poolName(row)} ${row.id} ${row.walletName ?? ''} ${row.wallet}`;

/**
 * Load data into a slot: a skeleton first (unless `quiet`, for refreshes), then draw(data), plus the server's notes above
 * it, or an error with a retry button. Aborts the previous load of the same slot.
 */
export function loader(slot, fetcher, draw, { rows = 5, notesSlot } = {}) {
  let controller;
  const run = async ({ quiet = false, force = false } = {}) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    if (!quiet || !slot.firstChild) clear(slot).append(skeleton(rows));
    try {
      const result = await fetcher({ signal, refresh: force });
      if (signal.aborted) return;
      clear(slot);
      const banner = notesBanner(result.notes);
      if (banner) (notesSlot ? clear(notesSlot) : slot).append(banner);
      else if (notesSlot) clear(notesSlot);
      draw(result, slot);
    } catch (error) {
      if (error.name === 'AbortError') return;
      clear(slot).append(errorBox(error, () => run({ force: true })));
    }
  };
  run.abort = () => controller?.abort();
  return run;
}

export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub && h('p', null, sub)), h('span', { class: 'grow' }), ...actions);
}

export const cli = cliHint;

export function sourceLine(result) {
  const parts = [];
  if (result?.data?.source) parts.push(result.data.source);
  if (result?.cachedAt) parts.push(`${result.cached ? 'cached' : 'updated'} ${new Date(result.cachedAt).toISOString().slice(11, 16)} UTC`);
  return parts.join(' · ');
}

export function linkTo(path, params, text) {
  const search = new URLSearchParams(Object.entries(params ?? {}).filter(([, value]) => value !== undefined && value !== '')).toString();
  return h('a', { href: `#/${path}${search ? `?${search}` : ''}` }, text);
}

export const external = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text, ' ', icon('external', 'i'));

/**
 * Put a report frame in a slot. Some browser extensions (popup blockers) drop iframes a page creates; until the frame
 * has loaded, it is checked every second and put back when it went missing (for up to two minutes). Returns a function
 * that stops the checks.
 */
export function mountFrame(slot, create) {
  let loaded = false;
  const make = () => {
    const frame = create();
    frame.addEventListener('load', () => { if (frame.isConnected) loaded = true; });
    slot.append(frame);
    return frame;
  };
  let frame = make();
  const started = Date.now();
  const timer = setInterval(() => {
    if (loaded || !slot.isConnected || Date.now() - started > 120_000) { clearInterval(timer); return; }
    if (!frame.isConnected) frame = make();
  }, 1000);
  return () => clearInterval(timer);
}

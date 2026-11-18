// Number and time formats, matching the CLI's tables (src/output.ts): compact USD, signed PnL, prices with decimals for
// their size, ages like 6h / 18d / 4.5y.

export const MISSING = '—';
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

export function usd(value, { compact = true, sign = false } = {}) {
  if (!isNum(value)) return MISSING;
  const abs = Math.abs(value);
  let text;
  if (compact && abs >= 1e9) text = `$${(abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`;
  else if (compact && abs >= 1e6) text = `$${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  else if (compact && abs >= 1e4) text = `$${(abs / 1e3).toFixed(1)}K`;
  else text = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const negative = value < 0 && text !== '$0.00';
  return `${negative ? '-' : sign && value > 0 ? '+' : ''}${text}`;
}

export const signedUsd = (value) => usd(value, { compact: false, sign: true });

export function pct(value, { sign = false, digits } = {}) {
  if (!isNum(value)) return MISSING;
  const abs = Math.abs(value);
  const places = digits ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  if (abs > 0 && abs < 0.01 && digits === undefined) return `${value < 0 ? '-' : sign ? '+' : ''}<0.01%`;
  return `${value < 0 ? '-' : sign && value > 0 ? '+' : ''}${abs.toFixed(places)}%`;
}

/** Prices and amounts with decimals for their size: 2,313.09, 1.0042, 0.05634, 0.000003721. */
export function num(value, { max } = {}) {
  if (!isNum(value)) return MISSING;
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  let digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(abs)));
  if (max !== undefined) digits = Math.min(digits, max);
  return value.toLocaleString('en-US', { minimumFractionDigits: abs >= 1000 ? 2 : 0, maximumFractionDigits: digits });
}

export function count(value) { return isNum(value) ? value.toLocaleString('en-US') : MISSING; }

export function compact(value) {
  if (!isNum(value)) return MISSING;
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function fee(tier) { return isNum(tier) ? `${+(tier / 10_000).toFixed(4)}%` : MISSING; }

export function age(iso, now = Date.now()) {
  if (!iso) return MISSING;
  const hours = (now - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return MISSING;
  if (hours < 48) return `${Math.max(1, Math.round(hours))}h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30.44)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

/** "2026-10-29 07:27" in UTC. */
export function time(value) {
  if (value === undefined || value === null || value === '') return MISSING;
  const date = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING : date.toISOString().slice(0, 16).replace('T', ' ');
}
export const day = (value) => time(value).slice(0, 10);

/** "3m ago" / "in 12s". */
export function ago(iso, now = Date.now()) {
  if (!iso) return MISSING;
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return MISSING;
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function duration(seconds) {
  if (!isNum(seconds)) return MISSING;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400 * 2) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export const short = (address) => address && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address ?? MISSING;

export const tone = (value) => !isNum(value) || value === 0 ? '' : value > 0 ? 'up' : 'down';

/** A stable color for a token symbol (avatar bubbles). */
export function tokenColor(symbol) {
  const palette = ['#2962ff', '#089981', '#f59f00', '#9c27b0', '#e91e63', '#00acc1', '#7cb342', '#8d6e63', '#5c6bc0', '#26a69a', '#ef6c00', '#ab47bc'];
  let hash = 0;
  for (const char of String(symbol ?? '?')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

/** Names the CLI uses for chains. */
export const chainName = (meta, idOrSlug) => meta?.chains.find((chain) => chain.id === idOrSlug || chain.slug === idOrSlug)?.name ?? String(idOrSlug);
export const chainSlug = (meta, id) => meta?.chains.find((chain) => chain.id === id)?.slug ?? String(id);

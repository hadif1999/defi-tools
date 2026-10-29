import type { Pool } from './types.js';

/** Filterable columns, named after the pool table headers. Values use the units shown there: USD, percent, ratio. */
const columns = {
  tvl: { label: 'TVL', get: (pool: Pool) => pool.tvlUsd, unit: '$' },
  volume: { label: '1D vol', get: (pool: Pool) => pool.volume24hUsd, unit: '$' },
  'volume-7d': { label: '7D vol', get: (pool: Pool) => pool.volume7dUsd, unit: '$' },
  'vol-tvl': { label: '1D vol/TVL', get: (pool: Pool) => pool.tvlUsd && pool.volume24hUsd !== undefined ? pool.volume24hUsd / pool.tvlUsd : undefined, unit: '' },
  apr: { label: 'APR', get: (pool: Pool) => pool.aprPct, unit: '%' },
  fee: { label: 'Fee', get: (pool: Pool) => pool.feeTier === undefined ? undefined : pool.feeTier / 10_000, unit: '%' },
  // In days. Age is looked up separately (DexScreener), so callers check needsDetails.
  age: { label: 'Age', get: (pool: Pool) => { const created = pool.createdAt ? Date.parse(pool.createdAt) : NaN; return Number.isFinite(created) ? (Date.now() - created) / 86_400_000 : undefined; }, unit: 'days' },
} as const;
type Column = keyof typeof columns;

// Spellings are compared after lowercasing and removing spaces, underscores and a leading "col.".
const aliases: Record<string, Column> = {
  tvl: 'tvl',
  volume: 'volume', vol: 'volume', '1dvol': 'volume', '1d-vol': 'volume', 'volume-1d': 'volume', '24hvol': 'volume',
  '7dvol': 'volume-7d', '7d-vol': 'volume-7d', 'volume-7d': 'volume-7d', 'vol-7d': 'volume-7d',
  'vol/tvl': 'vol-tvl', 'vol-tvl': 'vol-tvl', '1dvol/tvl': 'vol-tvl', 'volume/tvl': 'vol-tvl',
  apr: 'apr', fee: 'fee', 'fee-tier': 'fee', age: 'age', 'pool-age': 'age', poolage: 'age',
};
const operators = {
  '>=': (a: number, b: number) => a >= b, '<=': (a: number, b: number) => a <= b,
  '!=': (a: number, b: number) => a !== b, '==': (a: number, b: number) => a === b,
  '=': (a: number, b: number) => a === b, '>': (a: number, b: number) => a > b, '<': (a: number, b: number) => a < b,
} as const;

export const FILTER_COLUMNS = 'tvl, volume, volume-7d, vol/tvl, apr, fee, age';

export interface PoolFilter {
  /** Normalized form for display, e.g. "APR > 10%". */
  readonly text: string;
  /** True when the column (age) is not in the listing and must be looked up for each pool. */
  readonly needsDetails: boolean;
  matches(pool: Pool): boolean;
}

/**
 * Parse filters such as "apr>10", "vol/tvl >= 1", "tvl>1m", or several joined by commas or "and".
 * A pool without a value for the column never matches.
 */
export function parseFilters(expression: string): PoolFilter[] {
  // Split on commas only when a column name follows, so "tvl>1,000,000" stays one filter.
  const parts = expression.split(/\s*(?:&&|\band\b|,(?=\s*(?:[a-z]|\d+[dh])))\s*/i).filter((part) => part.trim());
  if (!parts.length) throw new Error('--filter needs a condition, e.g. --filter "apr>10".');
  return parts.map(parseFilter);
}

function parseFilter(expression: string): PoolFilter {
  const match = /^\s*(.+?)\s*(>=|<=|!=|==|=|>|<)\s*(.+?)\s*$/.exec(expression);
  if (!match) throw new Error(`--filter "${expression.trim()}" needs a column, an operator (> >= < <= = !=), and a number, e.g. "apr>10" or "vol/tvl>=1".`);
  const name = match[1]!.toLowerCase().replace(/^col\./, '').replace(/[\s_]/g, '');
  const key = aliases[name];
  if (!key) throw new Error(`--filter column "${match[1]}" is unknown. Use ${FILTER_COLUMNS}.`);
  const column = columns[key];
  const value = column.unit === 'days' ? parseDuration(match[3]!) : parseValue(match[3]!);
  if (value === undefined) {
    throw new Error(column.unit === 'days'
      ? `--filter age "${match[3]}" is not a duration. Use h, d, w, m (months), or y, e.g. "age>2m" or "age<30d".`
      : `--filter value "${match[3]}" is not a number. Examples: 10, 0.5, 250k, 1m, 5%.`);
  }
  const operator = match[2] as keyof typeof operators;
  const shown = column.unit === '$' ? `$${match[3]!.replace(/^\$/, '')}` : column.unit === '%' ? `${value}%` : column.unit === 'days' ? match[3]!.replace(/\s+/g, '').toLowerCase() : String(value);
  return {
    text: `${column.label} ${operator === '==' ? '=' : operator} ${shown}`,
    needsDetails: column.unit === 'days',
    matches: (pool) => {
      const actual = column.get(pool);
      return actual !== undefined && Number.isFinite(actual) && operators[operator](actual, value);
    },
  };
}

/** Durations in days: 12h, 30d, 2w, 2m or 2mo (months), 1.5y; a bare number means days. */
function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(h|hours?|d|days?|w|weeks?|m|mo|months?|y|years?)?$/i.exec(text.trim());
  if (!match) return undefined;
  const unit = (match[2] ?? 'd').toLowerCase();
  const days = unit.startsWith('h') ? 1 / 24 : unit.startsWith('w') ? 7 : unit.startsWith('m') ? 30.44 : unit.startsWith('y') ? 365.25 : 1;
  return Number(match[1]) * days;
}

/** Numbers like 10, -5, 0.05, 1,000,000, $250k, 1.5m, 2b, or 10% (percent sign is optional for percent columns). */
function parseValue(text: string): number | undefined {
  const match = /^\$?\s*(-?\d+(?:\.\d+)?)\s*([kmb%])?$/i.exec(text.trim().replaceAll(',', ''));
  if (!match) return undefined;
  const scale = { '': 1, '%': 1, k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase() as '' | '%' | 'k' | 'm' | 'b'];
  return Number(match[1]) * scale;
}

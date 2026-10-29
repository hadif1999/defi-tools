import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFilters } from '../src/filters.js';
import type { Pool } from '../src/types.js';

const pool = (overrides: Partial<Pool>): Pool => ({ id: 'p', chainId: 1, protocol: 'v3', token0: { address: '', symbol: 'A' }, token1: { address: '', symbol: 'B' }, source: 'defillama', observedAt: '', ...overrides });
const sample = pool({ tvlUsd: 2_000_000, volume24hUsd: 3_000_000, volume7dUsd: 9_000_000, aprPct: 12.5, feeTier: 500 });
const check = (expression: string, target = sample) => parseFilters(expression).every((filter) => filter.matches(target));

test('filters on table columns with any spelling, case, and spacing', () => {
  assert.equal(check('apr>10'), true);
  assert.equal(check('col.APR > 10%'), true);
  assert.equal(check('APR>=12.5'), true);
  assert.equal(check('apr<10'), false);
  assert.equal(check('vol/TVL>1'), true);
  assert.equal(check('1D vol/TVL >= 2'), false);
  assert.equal(check('tvl>1m'), true);
  assert.equal(check('TVL >= $2,000,000'), true);
  assert.equal(check('volume<250k'), false);
  assert.equal(check('7d vol > 5m'), true);
  assert.equal(check('fee<=0.05'), true);
  assert.equal(check('fee = 0.3'), false);
  assert.equal(check('fee != 0.3'), true);
});

test('several conditions combine with AND; missing values never match', () => {
  assert.equal(parseFilters('apr>10, tvl>1,000,000 and vol/tvl>1').length, 3);
  assert.equal(check('apr>10, tvl>1,000,000 and vol/tvl>1'), true);
  assert.equal(check('apr>10 && tvl>5m'), false);
  assert.equal(check('apr>0', pool({ tvlUsd: 1 })), false);
  assert.equal(check('apr<1000', pool({ tvlUsd: 1 })), false);
  assert.equal(check('vol/tvl>0', pool({ tvlUsd: 0, volume24hUsd: 5 })), false);
});

test('explains malformed filters', () => {
  assert.throws(() => parseFilters('apr'), /needs a column, an operator/);
  assert.throws(() => parseFilters('fees>1'), /column "fees" is unknown/);
  assert.throws(() => parseFilters('apr>ten'), /value "ten" is not a number/);
  assert.throws(() => parseFilters('  '), /needs a condition/);
  assert.equal(parseFilters('col.apr>10')[0]!.text, 'APR > 10%');
  assert.equal(parseFilters('vol/tvl>=1')[0]!.text, '1D vol/TVL >= 1');
  assert.equal(parseFilters('tvl>1m')[0]!.text, 'TVL > $1m');
});

test('age filters accept durations and need a lookup', () => {
  const daysAgo = (days: number) => pool({ createdAt: new Date(Date.now() - days * 86_400_000).toISOString() });
  const [filter] = parseFilters('Age>2m');
  assert.equal(filter!.needsDetails, true);
  assert.equal(filter!.text, 'Age > 2m');
  assert.equal(parseFilters('apr>1')[0]!.needsDetails, false);
  assert.equal(check('age>2m', daysAgo(70)), true);
  assert.equal(check('age>2m', daysAgo(50)), false);
  assert.equal(check('age>=2mo', daysAgo(61)), true);
  assert.equal(check('age<30d', daysAgo(29)), true);
  assert.equal(check('age<30', daysAgo(31)), false); // A bare number is days.
  assert.equal(check('age<2w', daysAgo(13)), true);
  assert.equal(check('age<12h', daysAgo(0.25)), true);
  assert.equal(check('pool age > 1.5y', daysAgo(600)), true);
  assert.equal(check('age > 1 year', daysAgo(400)), true);
  assert.equal(check('age>1d', pool({})), false); // Unknown age never matches.
  assert.equal(check('age<100y', pool({})), false);
  assert.throws(() => parseFilters('age>2x'), /age "2x" is not a duration/);
  assert.equal(parseFilters('age>2m, tvl>1m').length, 2);
});

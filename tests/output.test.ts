import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFee, formatPercent, formatUsd, renderTable, volumeToTvl } from '../src/output.js';
import { parseUsdAmount } from '../src/config.js';
import type { Pool } from '../src/types.js';

const pool = (overrides: Partial<Pool>): Pool => ({ id: 'p', chainId: 1, protocol: 'v3', token0: { address: '', symbol: 'A' }, token1: { address: '', symbol: 'B' }, source: 'defillama', observedAt: '', ...overrides });

test('formats amounts the way the Uniswap Explore page does', () => {
  assert.equal(formatUsd(492.84), '$492.84');
  assert.equal(formatUsd(385_100), '$385.1K');
  assert.equal(formatUsd(134_200_000), '$134.2M');
  assert.equal(formatUsd(1_150_000_000), '$1.1B');
  assert.equal(formatUsd(999_960), '$1.0M');
  assert.equal(formatUsd(undefined), '—');
  assert.equal(formatPercent(30.391), '30.39%');
  assert.equal(formatPercent(0), '0.00%');
  assert.equal(formatPercent(0.004), '<0.01%');
  assert.equal(formatFee(pool({ feeTier: 3000 })), '0.3%');
  assert.equal(formatFee(pool({ feeTier: 5 })), '0.0005%');
  assert.equal(formatFee(pool({ feeLabel: 'dynamic' })), 'dynamic');
  assert.equal(formatFee(pool({})), '—');
  assert.equal(volumeToTvl(pool({ tvlUsd: 100, volume24hUsd: 47 })), '0.47');
  assert.equal(volumeToTvl(pool({ tvlUsd: 1_000_000, volume24hUsd: 5 })), '<0.01');
  assert.equal(volumeToTvl(pool({ tvlUsd: 0, volume24hUsd: 5 })), '—');
});

test('renders aligned tables with right-aligned numbers and truncated names', () => {
  const lines = renderTable([{ header: '#', align: 'right' }, { header: 'Pool', max: 6 }, { header: 'TVL', align: 'right' }], [
    ['1', 'ETH/USDC', '$1.0M'], ['10', 'A/B', '$5.00'],
  ]).split('\n');
  assert.deepEqual(lines, [
    ' #  Pool      TVL',
    '──  ──────  ─────',
    ' 1  ETH/U…  $1.0M',
    '10  A/B     $5.00',
  ]);
});

test('parses dollar amounts with k/m/b suffixes', () => {
  assert.equal(parseUsdAmount('50000', '--min-tvl'), 50_000);
  assert.equal(parseUsdAmount('250k', '--min-tvl'), 250_000);
  assert.equal(parseUsdAmount('$1.5M', '--min-tvl'), 1_500_000);
  assert.equal(parseUsdAmount('1,000,000', '--min-tvl'), 1_000_000);
  assert.equal(parseUsdAmount(undefined, '--min-tvl'), undefined);
  for (const bad of ['abc', '-5', '1x', '']) assert.throws(() => parseUsdAmount(bad, '--min-tvl'), /--min-tvl must be a dollar amount/);
});

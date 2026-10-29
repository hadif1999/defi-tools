import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePosition, buildAlerts, scorePool, sortPools } from '../src/analytics.js';
import type { Pool, Position } from '../src/types.js';

const position: Position = { id: 'p1', wallet: '0xabc', poolId: '0xpool', chainId: 1, protocol: 'v3', lowerTick: 100, upperTick: 200, source: 'mixed' };

test('classifies positions near boundaries and outside range', () => {
  assert.equal(analyzePosition(position, 105).status, 'near_lower');
  assert.equal(analyzePosition(position, 195).status, 'near_upper');
  assert.equal(analyzePosition(position, 250).status, 'out_of_range_above');
  assert.equal(analyzePosition(position, 150).status, 'in_range');
});

test('builds deduplicatable alerts', () => {
  const analysis = analyzePosition(position, 250);
  const alerts = buildAlerts([analysis], new Map());
  assert.equal(alerts[0]?.type, 'out_of_range');
  assert.equal(alerts[0]?.fingerprint, '1:v3:0xabc:p1:out_of_range:out_of_range_above');
});

test('scores pools with explainable components', () => {
  const pool: Pool = { id: 'pool', chainId: 1, protocol: 'v3', token0: { address: 'a', symbol: 'A', decimals: 18 }, token1: { address: 'b', symbol: 'B', decimals: 18 }, tvlUsd: 1_000_000, volume24hUsd: 2_000_000, fees24hUsd: 10_000, price: 1, source: 'uniswap-api', observedAt: new Date().toISOString() };
  const score = scorePool(pool);
  assert.ok(score.score > 0 && score.score <= 100);
  assert.ok(score.confidence < 1); // A token price does not supply historical volatility.
  assert.equal(score.components.utilization, 0.4);
});

test('unknown v4 hooks and missing public metrics do not imply full confidence', () => {
  const pool: Pool = { id: 'pool', chainId: 1, protocol: 'v4', token0: { address: 'a', symbol: 'A' }, token1: { address: 'b', symbol: 'B' }, tvlUsd: 1000, volume24hUsd: 100, price: 1, source: 'geckoterminal', observedAt: new Date().toISOString() };
  const score = scorePool(pool);
  assert.ok(score.confidence <= 0.5);
  assert.match(score.reasons.join(' '), /hook.*unknown/i);
});

test('upper tick is outside the active Uniswap range and alerts distinguish networks', () => {
  assert.equal(analyzePosition(position, 200).status, 'out_of_range_above');
  const alerts = buildAlerts([analyzePosition(position, 250), analyzePosition({ ...position, chainId: 8453 }, 250)], new Map());
  assert.notEqual(alerts[0]?.fingerprint, alerts[1]?.fingerprint);
});

test('sorts by several keys, highest first, with missing values last', () => {
  const make = (id: string, tvlUsd: number | undefined, aprPct: number | undefined, volume24hUsd?: number): Pool => ({ id, chainId: 1, protocol: 'v3', token0: { address: 'a', symbol: 'A' }, token1: { address: 'b', symbol: 'B' }, tvlUsd, aprPct, volume24hUsd, source: 'defillama', observedAt: '' });
  const pools = [make('a', 100, 5), make('b', 300, 1), make('c', 100, 9), make('d', undefined, 50), make('e', 100, undefined)];
  assert.deepEqual(sortPools(pools, ['tvl', 'apr']).map((pool) => pool.id), ['b', 'c', 'a', 'e', 'd']);
  assert.deepEqual(sortPools(pools, ['apr']).map((pool) => pool.id), ['d', 'c', 'a', 'b', 'e']);
  // Equal volume falls through to APR, then TVL.
  const tied = [make('x', 10, 1, 7), make('y', 20, 1, 7), make('z', 5, 3, 7)];
  assert.deepEqual(sortPools(tied, ['volume', 'apr']).map((pool) => pool.id), ['z', 'y', 'x']);
  assert.deepEqual(pools.map((pool) => pool.id), ['a', 'b', 'c', 'd', 'e']); // Input is not mutated.
});

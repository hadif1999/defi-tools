import type { Alert, Pool, PoolScore, PoolSort, Position, PositionAnalysis, RangeStatus } from './types.js';
import { alertFingerprint } from './storage.js';

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const normalize = (value: number | undefined, scale: number): number => value == null ? 0 : clamp(value / scale);

export function scorePool(pool: Pool): PoolScore {
  const feeQuality = clamp(normalize(pool.fees24hUsd, 50_000));
  const liquidityQuality = clamp(normalize(pool.tvlUsd, 10_000_000));
  const utilization = pool.tvlUsd && pool.volume24hUsd != null ? clamp(pool.volume24hUsd / pool.tvlUsd / 5) : 0;
  const volatilityRisk = pool.volatility24hPct == null ? 0.5 : clamp(1 - pool.volatility24hPct / 100);
  const unknownHook = pool.protocol === 'v4' && pool.hook === undefined;
  const hasHook = pool.hook && !/^0x0{40}$/i.test(pool.hook);
  const concentrationRisk = unknownHook ? 0.2 : hasHook ? 0.35 : 0.8;
  const score = 100 * (feeQuality * 0.35 + liquidityQuality * 0.2 + utilization * 0.2 + volatilityRisk * 0.15 + concentrationRisk * 0.1);
  const available = [pool.fees24hUsd, pool.tvlUsd, pool.volume24hUsd, pool.volatility24hPct].filter((x) => x != null && Number.isFinite(x)).length;
  const confidence = available / 4;
  const reasons = [
    `${Math.round(feeQuality * 100)}% fee-generation quality`,
    `${Math.round(liquidityQuality * 100)}% liquidity quality`,
    `${Math.round(utilization * 100)}% volume utilization`,
  ];
  if (hasHook) reasons.push('v4 hook risk requires additional review');
  if (unknownHook) reasons.push('v4 hook behavior is unknown');
  if (pool.fees24hUsd === undefined) reasons.push('fee yield unavailable');
  if (pool.volatility24hPct === undefined) reasons.push('historical volatility unavailable');
  if (confidence < 0.75) reasons.push('some metrics are unavailable');
  return { pool, score, confidence, components: { feeQuality, liquidityQuality, utilization, volatilityRisk, concentrationRisk }, reasons };
}

const sortKeys: Record<PoolSort, (pool: Pool) => number | undefined> = {
  tvl: (pool) => pool.tvlUsd,
  volume: (pool) => pool.volume24hUsd,
  apr: (pool) => pool.aprPct,
  'vol-tvl': (pool) => pool.tvlUsd && pool.volume24hUsd !== undefined ? pool.volume24hUsd / pool.tvlUsd : undefined,
};

/**
 * Highest first, like the Uniswap Explore page. Later keys break ties in earlier ones, and TVL breaks any
 * remaining tie. Pools missing a metric go last for that key. Returns a new array.
 */
export function sortPools(pools: Pool[], sorts: readonly PoolSort[]): Pool[] {
  const keys = [...sorts, 'tvl' as const].map((sort) => sortKeys[sort]);
  return [...pools].sort((a, b) => {
    for (const key of keys) {
      const difference = (key(b) ?? -Infinity) - (key(a) ?? -Infinity);
      if (difference) return difference;
    }
    return 0;
  });
}

export function analyzePosition(position: Position, currentTick: number | undefined, thresholdPct = 0.1): PositionAnalysis {
  if (currentTick == null || position.lowerTick == null || position.upperTick == null || position.upperTick <= position.lowerTick) {
    return { ...position, currentTick, status: 'unknown', reason: 'Current tick or position bounds are unavailable.' };
  }
  const width = position.upperTick - position.lowerTick;
  if (currentTick < position.lowerTick) return { ...position, currentTick, status: 'out_of_range_below', distanceToBoundaryPct: 0, reason: 'Price is below the lower tick.' };
  if (currentTick >= position.upperTick) return { ...position, currentTick, status: 'out_of_range_above', distanceToBoundaryPct: 0, reason: 'Price is at or above the upper tick.' };
  const fromLower = (currentTick - position.lowerTick) / width;
  const fromUpper = (position.upperTick - currentTick) / width;
  if (fromLower <= thresholdPct) return { ...position, currentTick, status: 'near_lower', distanceToBoundaryPct: fromLower, reason: 'Price is close to the lower tick boundary.' };
  if (fromUpper <= thresholdPct) return { ...position, currentTick, status: 'near_upper', distanceToBoundaryPct: fromUpper, reason: 'Price is close to the upper tick boundary.' };
  return { ...position, currentTick, status: 'in_range', distanceToBoundaryPct: Math.min(fromLower, fromUpper), reason: 'Price is comfortably inside the configured range.' };
}

export function buildAlerts(analyses: PositionAnalysis[], previous: Map<string, RangeStatus>, now = new Date()): Alert[] {
  const alerts: Alert[] = [];
  for (const analysis of analyses) {
    const previousStatus = previous.get(analysis.id);
    let type: Alert['type'] | undefined;
    if (analysis.status === 'out_of_range_below' || analysis.status === 'out_of_range_above') type = 'out_of_range';
    else if (analysis.status === 'near_lower' || analysis.status === 'near_upper') type = 'near_boundary';
    else if (previousStatus && previousStatus !== 'in_range' && analysis.status === 'in_range') type = 'recovered';
    if (!type) continue;
    alerts.push({
      fingerprint: alertFingerprint(analysis, type),
      type,
      wallet: analysis.wallet,
      positionId: analysis.id,
      message: `${analysis.wallet} ${analysis.id}: ${analysis.reason}`,
      createdAt: now.toISOString(),
      acknowledged: false,
    });
  }
  return alerts;
}

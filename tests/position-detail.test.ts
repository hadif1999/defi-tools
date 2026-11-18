import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsAt, analyzePositionDetail, capitalEfficiency, pickPosition, unitsFor } from '../src/position-detail.js';
import { positionEvents } from '../src/providers/revert.js';
import { renderPositionDetail, statusLine } from '../src/position-view.js';
import { renderLineChart, visible } from '../src/terminal-chart.js';
import { buildPositionHtml } from '../src/position-html.js';
import { splitPositions } from '../src/positions.js';
import type { Candle } from '../src/dex-data.js';
import type { LpPosition } from '../src/types.js';

const DAY = 86_400;
const OPENED = 1_790_000_000;
const NOW = OPENED + 10 * DAY;
const WETH = { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH', decimals: 18, priceUsd: 2500 };
const USDC = { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, priceUsd: 1 };

/** A WETH/USDC position (token0 WETH): range 2000–3000, entered at 2500, with liquidity for ~1 WETH + 2,500 USDC. */
function position(overrides: Partial<LpPosition> = {}): LpPosition {
  const units = unitsFor(1, 2500, 2500, 2000, 3000)!;
  const [amount0, amount1] = amountsAt(units, 2500, 2000, 3000);
  return {
    id: '777', chainId: 42161, dex: 'Uniswap', protocol: 'v3', wallet: '0x902ebd8f3a08731224a1c216f84f34ce5f4d3f00', pool: '0xc6962004f452be9203591991d15f6b388e09e8d0',
    token0: WETH, token1: USDC, feeTier: 500, tickLower: -200000, tickUpper: -196000, currentTick: -198000,
    priceLower: 2000, priceUpper: 3000, price: 2500, liquidity: String(Math.round(units * 1e12)), active: true, inRange: true,
    amount0, amount1, valueUsd: amount0 * 2500 + amount1, uncollectedFees0: 0.01, uncollectedFees1: 20, uncollectedFeesUsd: 45,
    feesEarnedUsd: 60, depositedUsd: amount0 * 2500 + amount1, withdrawnUsd: 0, gasUsd: 1, pnlUsd: 59, ilUsd: 0, feeAprPct: 40, totalAprPct: 39,
    openedAt: new Date(OPENED * 1000).toISOString(), source: 'revert', historyAvailable: true,
    events: [{ kind: 'deposit', timestamp: OPENED, hash: '0xabc', amount0, amount1, price: 2500, valueUsd: amount0 * 2500 + amount1, gasUsd: 1 }],
    ...overrides,
  };
}
const candles = (closes: number[], start = OPENED - DAY, step = DAY): Candle[] => closes.map((close, i) => ({ timestamp: start + i * step, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1, filled: false }));

test('concentrated-liquidity math: amounts, liquidity and capital efficiency agree', () => {
  const units = unitsFor(1, 2500, 2500, 2000, 3000)!;
  const [amount0, amount1] = amountsAt(units, 2500, 2000, 3000);
  // The smaller side limits the liquidity, as when minting; the other side is what the pool takes.
  assert.ok(amount0 <= 1 + 1e-9 && amount1 <= 2500 + 1e-6);
  assert.ok(Math.abs(amount0 - 1) < 1e-9 || Math.abs(amount1 - 2500) < 1e-6);
  // Below the range only token0 is held, above it only token1.
  assert.equal(amountsAt(units, 1500, 2000, 3000)[1], 0);
  assert.equal(amountsAt(units, 3500, 2000, 3000)[0], 0);
  // Range 0.25–4 around 1: a full-range position needs 2× the capital.
  assert.ok(Math.abs(capitalEfficiency(1, 0.25, 4)! - 2) < 1e-12);
  assert.equal(capitalEfficiency(5, 0.25, 4), undefined);
});

test('Revert cash flows become positive-amount events, with each transaction\'s gas counted once', () => {
  const prices = { token0: { usd: 2000 }, token1: { usd: 1 } };
  const { events, depositLiquidity } = positionEvents([
    { type: 'gas-costs', tx_hash: '0x1', amount: '-0.0001', amount_usd: '-0.20', timestamp: 100 },
    { type: 'deposits', tx_hash: '0x1', amount0: '-0.5', amount1: '-1000', price: 2000, timestamp: 100, liquidity: 123456, prices },
    { type: 'gas-costs', tx_hash: '0x2', amount: '-0.0001', amount_usd: '-0.30', timestamp: 200 },
    { type: 'claimed-fees', tx_hash: '0x2', amount0: '0.001', amount1: '2', timestamp: 200, prices },
    { type: 'withdrawals', tx_hash: '0x2', amount0: '0.6', amount1: '800', price: 1900, timestamp: 200, prices },
    { type: 'unclaimed-fees-state', amount0: '0', amount1: '0', timestamp: 300 },
  ]);
  assert.deepEqual(events.map((event) => [event.kind, event.amount0, event.amount1, event.gasUsd]), [['deposit', 0.5, 1000, 0.2], ['collect', 0.001, 2, 0.3], ['withdraw', 0.6, 800, undefined]]);
  assert.equal(events[0]!.valueUsd, 2000);
  // Without a price field, the price comes from the tokens' USD prices.
  assert.equal(events[1]!.price, 2000);
  assert.equal(depositLiquidity, '123456');
});

test('an open position: range figures, curve, what-if prices and a breakeven where PnL crosses zero', () => {
  const detail = analyzePositionDetail({ position: position(), candles: candles([2400, 2500, 2600, 3100, 2900, 2500, 2450, 2500, 2550, 2500, 2500, 2500]), timeframe: '1d', step: DAY, livePrice: 2500, now: NOW });
  assert.equal(detail.pair, 'WETH/USDC');
  assert.equal(detail.unit, 'USDC per WETH');
  assert.equal(detail.status, 'in');
  assert.equal(detail.tickSpacing, 10);
  assert.ok(Math.abs(detail.prices.widthPct - 50) < 1e-9);
  assert.ok(Math.abs(detail.prices.rangePositionPct! - Math.log(1.25) / Math.log(1.5) * 100) < 1e-9);
  assert.equal(detail.liquidity.curveFrom, 'current');
  // Holding the entry tokens matches the position at entry, and the position does worse everywhere else.
  const atEntry = detail.curve.find((point) => point.price === 2500)!;
  assert.ok(Math.abs(atEntry.ilPct) < 1e-9);
  assert.ok(detail.curve.every((point) => point.ilPct <= 1e-9));
  // What-if: "Now" is the current value; prices are sorted; the limits are included.
  const now = detail.scenarios.find((row) => row.label === 'Now')!;
  assert.ok(Math.abs(now.valueUsd! - detail.holdings.valueUsd!) < 1e-6);
  assert.deepEqual(detail.scenarios.map((row) => row.price), [...detail.scenarios.map((row) => row.price)].sort((a, b) => a - b));
  assert.ok(detail.scenarios.some((row) => row.label === 'At lower limit' && row.price === 2000));
  // PnL at the breakeven price is zero.
  const breakeven = detail.performance.breakeven!;
  const at = analyzePositionDetail({ position: position(), livePrice: breakeven, now: NOW }).scenarios.find((row) => row.label === 'Now')!;
  assert.ok(Math.abs(at.pnlUsd!) < 1e-6, String(at.pnlUsd));
  assert.ok(breakeven < 2500);
  // Time in range: 1 of the 10 daily closes while open was above 3000.
  assert.equal(detail.history!.candles, 10);
  assert.ok(Math.abs(detail.history!.inRangePct! - 90) < 1e-9);
  assert.equal(detail.history!.exits, 1);
  assert.ok(detail.history!.daysToLower! > 0 && detail.history!.daysToUpper! > 0);
});

test('prices quoted in the more money-like token: a USDC/WETH pool is shown in USDC per WETH', () => {
  // token0 USDC, token1 WETH: raw prices are WETH per USDC.
  const flipped = position({ token0: USDC, token1: WETH, priceLower: 1 / 3000, priceUpper: 1 / 2000, price: 1 / 2500, amount0: 2500, amount1: 1, uncollectedFees0: 20, uncollectedFees1: 0.01,
    events: [{ kind: 'deposit', timestamp: OPENED, amount0: 2500, amount1: 1, price: 1 / 2500 }] });
  const detail = analyzePositionDetail({ position: flipped, now: NOW });
  assert.equal(detail.inverted, true);
  assert.equal(detail.unit, 'USDC per WETH');
  assert.ok(Math.abs(detail.prices.lower - 2000) < 1e-6 && Math.abs(detail.prices.upper - 3000) < 1e-6 && Math.abs(detail.prices.entry! - 2500) < 1e-6);
  assert.deepEqual([detail.holdings.base, detail.holdings.quote], [1, 2500]);
  assert.deepEqual([detail.flows.uncollected.base, detail.flows.uncollected.quote], [0.01, 20]);
});

test('a closed position: status, exit, curve from the deposit\'s liquidity, holding valued at the exit, no what-if', () => {
  const closedAt = OPENED + 5 * DAY;
  const closed = position({
    active: false, liquidity: '0', amount0: 0, amount1: 0, valueUsd: 0, price: 1800, exitPrice: 2900, closedAt: new Date(closedAt * 1000).toISOString(), depositLiquidity: '5000000000000000',
    events: [
      { kind: 'deposit', timestamp: OPENED, amount0: 1, amount1: 2500, price: 2500, valueUsd: 5000 },
      { kind: 'withdraw', timestamp: closedAt, amount0: 0.2, amount1: 4600, price: 2900, valueUsd: 5180 },
    ],
  });
  const detail = analyzePositionDetail({ position: closed, now: NOW });
  assert.equal(detail.status, 'closed');
  assert.equal(detail.prices.exit, 2900);
  assert.equal(detail.liquidity.curveFrom, 'deposit');
  assert.equal(detail.scenarios.length, 0);
  // Holding 1 WETH + 2,500 USDC at the exit price of 2,900 (USDC at $1, from the withdrawal's own value).
  assert.ok(Math.abs(detail.performance.hodlUsd! - 5400) < 1e-6);
  assert.match(statusLine(detail), /Closed .* exit price 2,900/);
});

test('picking a position by NFT ID or by positions list row number', () => {
  const open = [position({ id: '10', valueUsd: 5 }), position({ id: '11', valueUsd: 50 })];
  const past = [position({ id: '12', active: false, closedAt: '2026-01-01T00:00:00Z' })];
  const all = [...open, ...past];
  const ordered = splitPositions(all);
  assert.equal(pickPosition(all, '12', { ordered }).position.id, '12');
  assert.equal(pickPosition(all, '#10', { ordered }).position.id, '10');
  // Row 1 of the open table is the largest value; --past counts closed positions.
  assert.equal(pickPosition(all, '1', { ordered }).position.id, '11');
  assert.equal(pickPosition(all, '1', { past: true, ordered }).position.id, '12');
  // With nothing open, a row number counts closed positions.
  assert.equal(pickPosition(past, '1', { ordered: splitPositions(past) }).position.id, '12');
  assert.throws(() => pickPosition(all, '#99', { ordered }), /No position #99/);
  assert.throws(() => pickPosition(all, '5', { ordered }), /no row 5 among the 2 open positions/);
  assert.throws(() => pickPosition(all, 'abc', { ordered }), /neither a position ID nor a row number/);
  const twice = [position({ id: '10' }), position({ id: '10', chainId: 8453 })];
  assert.throws(() => pickPosition(twice, '10', { ordered: splitPositions(twice) }), /exists on Arbitrum and Base; add --chain/);
});

test('the terminal report shows the gauge, both charts, the sections and the transactions; --no-plot leaves out the charts', () => {
  const series = candles([2400, 2500, 2600, 3100, 2900, 2500, 2450, 2500, 2550, 2500, 2500, 2500]);
  const detail = analyzePositionDetail({ position: position(), candles: series, timeframe: '1d', step: DAY, livePrice: 2500, now: NOW });
  const text = renderPositionDetail(detail, { width: 120, height: 40, color: false, plot: true, candles: series, timeframe: '1d' });
  for (const part of ['WETH/USDC 0.05%', '● In range', '2,000.00 ├', '┤ 3,000.00', '◀ upper 3,000.00', '◀ lower 2,000.00', '◀ 2,500.00', 'Value against price', 'What if the price moved now', 'Transactions (1)', 'Breakeven', 'Time in range']) {
    assert.ok(text.includes(part), `missing ${part}`);
  }
  assert.deepEqual(text.split('\n').filter((line) => visible(line).length > 120), [], 'a line is wider than the terminal');
  const plain = renderPositionDetail(detail, { width: 120, height: 40, color: false, plot: false, candles: series, timeframe: '1d' });
  assert.ok(!plain.includes('Value against price') && !plain.includes('◀ upper'));
  assert.ok(plain.includes('What if the price moved now'));
});

test('braille line chart: fits its size and labels the markers', () => {
  const points: Array<[number, number]> = Array.from({ length: 50 }, (_, i) => [i, Math.sin(i / 8)]);
  const lines = renderLineChart([{ points, color: 'blue' }], { width: 60, height: 8, color: false, markers: [{ x: 25, label: 'now', color: 'yellow' }] });
  assert.equal(lines.length, 9);
  assert.ok(lines.every((line) => visible(line).length <= 60));
  assert.ok(lines.at(-1)!.includes('now'));
  assert.ok(lines.slice(0, -1).join('').match(/[⠁-⣿]/));
});

test('the HTML report embeds the analysis and the candles as parseable JSON', () => {
  const series = candles([2400, 2500, 2600]);
  const detail = analyzePositionDetail({ position: position({ token0: { ...WETH, symbol: 'W</script>ETH' } }), candles: series, timeframe: '1d', step: DAY, now: NOW });
  const html = buildPositionHtml(detail, { candles: series, timeframe: '1d', step: DAY, plot: true });
  assert.ok(!html.includes('W</script>ETH'));
  const data = JSON.parse(/<script type="application\/json" id="report-data">(.*?)<\/script>/s.exec(html)![1]!);
  assert.equal(data.detail.id, '777');
  assert.equal(data.candles.length, 3);
  // Without charts the charting library is left out.
  assert.ok(html.length - buildPositionHtml(detail, { candles: series, timeframe: '1d', step: DAY, plot: false }).length > 100_000);
});

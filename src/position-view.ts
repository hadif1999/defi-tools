import type { Candle } from './dex-data.js';
import { formatAge, formatNumber, formatPercent, formatSignedUsd, formatUsd, palette, renderTable, type Column } from './output.js';
import { renderCandleChart, renderLineChart, visible, type ChartLevel, type TermColor } from './terminal-chart.js';
import { txLink, type PositionDetail } from './position-detail.js';

// positions detail in the terminal: a header with the status, a range gauge, the price chart with the range, entry
// and events, the value-against-price curve, and tables for the figures behind them.

const MISSING = '—';
const signed = (value: number | undefined, digits = 2) => value === undefined || !Number.isFinite(value) ? MISSING : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
const time = (seconds: number | undefined) => seconds === undefined ? MISSING : new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
const iso = (text: string | undefined) => text ? time(Date.parse(text) / 1000) : MISSING;
const amount = (value: number | undefined, symbol: string) => value === undefined ? MISSING : `${formatNumber(value)} ${symbol}`;
const days = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? MISSING : value < 1 ? `${(value * 24).toFixed(1)} h` : value < 100 ? `${value.toFixed(1)} d` : `${Math.round(value)} d`;

/** Plain text wrapped at word boundaries to the terminal width. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

export const STATUS_TEXT: Record<PositionDetail['status'], string> = { in: 'In range', below: 'Below range', above: 'Above range', closed: 'Closed' };

/** One-line status: "● In range · 38% through the range" or "▼ Below range by 12.4%". */
export function statusLine(detail: PositionDetail): string {
  const { prices } = detail;
  if (detail.status === 'closed') return `■ Closed${detail.closedAt ? ` ${iso(detail.closedAt).slice(0, 10)}` : ''}${prices.exit !== undefined ? ` · exit price ${formatNumber(prices.exit)}` : ''}`;
  if (detail.status === 'in') return `● In range${prices.rangePositionPct === undefined ? '' : ` · ${prices.rangePositionPct.toFixed(0)}% of the way from lower to upper`}`;
  return `${detail.status === 'below' ? '▼' : '▲'} ${STATUS_TEXT[detail.status]} by ${Math.abs(prices.outsidePct ?? 0).toFixed(1)}% · earning no fees, holding only ${detail.status === 'below' ? detail.base.symbol : detail.quote.symbol}`;
}

/**
 * The range as a bar: limits at its ends, ● the price now (or ◆ the exit), ▴ the entry. A price outside the range
 * sits in the margin beyond the end it passed. Positions are on a log scale, as ticks are.
 */
export function rangeGauge(detail: PositionDetail, width: number, color: boolean): string[] {
  const paint = palette(color);
  const { lower, upper, entry } = detail.prices;
  const now = detail.active ? detail.prices.live ?? detail.prices.current : detail.prices.exit ?? detail.prices.current;
  const left = formatNumber(lower);
  const right = formatNumber(upper);
  const bar = Math.max(16, Math.min(60, width - left.length - right.length - 12));
  const at = (price: number) => Math.log(price / lower) / Math.log(upper / lower);
  const cells = Array.from({ length: bar }, () => '─');
  const column = (price: number) => Math.round(at(price) * (bar - 1));
  let [before, after] = ['   ', '   '];
  const marker = detail.active ? '●' : '◆';
  const markColor = detail.status === 'in' ? paint.green : detail.status === 'closed' ? (text: string) => text : paint.red;
  if (entry !== undefined && at(entry) >= 0 && at(entry) <= 1) cells[column(entry)] = '▴';
  if (now !== undefined) {
    if (now < lower) before = ` ${markColor(marker)} `;
    else if (now > upper) after = ` ${markColor(marker)} `;
    else cells[column(now)] = markColor(marker);
  }
  const lines = [`${before}${left} ├${cells.join('')}┤ ${right}${after}`];
  const legend = [now !== undefined ? `${marker} ${detail.active ? 'now' : 'exit'} ${formatNumber(now)}` : undefined, entry !== undefined ? `▴ entry ${formatNumber(entry)}` : undefined,
    `width ${detail.prices.widthPct.toFixed(1)}%`, detail.unit].filter(Boolean);
  lines.push(paint.dim(`   ${legend.join(' · ')}`));
  return lines;
}

/** Labelled values in two aligned columns; sections side by side when the terminal is wide enough. */
function sections(groups: Array<[string, Array<[string, string]>]>, width: number, color: boolean): string[] {
  const paint = palette(color);
  const blocks = groups.map(([title, rows]) => {
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    return [paint.bold(title), ...rows.map(([label, value]) => `${paint.dim(label.padEnd(labelWidth))}  ${value}`)];
  });
  const widest = Math.max(...blocks.flat().map((line) => visible(line).length)) + 4;
  const perRow = Math.max(1, Math.min(3, Math.floor(width / widest)));
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i += perRow) {
    const row = blocks.slice(i, i + perRow);
    const height = Math.max(...row.map((block) => block.length));
    for (let line = 0; line < height; line += 1) out.push(row.map((block) => { const text = block[line] ?? ''; return text + ' '.repeat(Math.max(0, widest - visible(text).length)); }).join('').trimEnd());
    out.push('');
  }
  return out;
}

export interface PositionViewOptions { width: number; height: number; color: boolean; plot: boolean; candles?: Candle[]; timeframe?: string; dataNote?: string }

export function renderPositionDetail(detail: PositionDetail, options: PositionViewOptions): string {
  const paint = palette(options.color);
  const out: string[] = [];
  const { prices, performance: perf, flows, history } = detail;
  const fee = detail.feeTier === undefined ? '' : ` ${detail.feeTier / 10_000}%`;
  out.push(`${paint.bold(`${detail.pair}${fee}`)}  ${paint.dim(`${detail.dex} ${detail.protocol} · ${detail.chain} · position #${detail.id} · ${detail.walletName ?? `${detail.wallet.slice(0, 6)}…${detail.wallet.slice(-4)}`}`)}`);
  const status = statusLine(detail);
  out.push(detail.status === 'in' ? paint.green(status) : detail.status === 'closed' ? status : paint.red(status));
  out.push('', ...rangeGauge(detail, options.width, options.color), '');

  if (options.plot && options.candles?.length) {
    const levels: ChartLevel[] = [{ price: prices.upper, label: 'upper', color: 'green' }, { price: prices.lower, label: 'lower', color: 'green' }];
    if (prices.entry !== undefined) levels.push({ price: prices.entry, label: 'entry', color: 'blue' });
    if (!detail.active && prices.exit !== undefined) levels.push({ price: prices.exit, label: 'exit', color: 'magenta' });
    if (perf.breakeven !== undefined) levels.push({ price: perf.breakeven, label: 'breakeven', color: 'cyan' });
    const glyphs: Record<string, [string, TermColor]> = { deposit: ['▲', 'blue'], withdraw: ['▼', 'magenta'], collect: ['$', 'yellow'] };
    const chartHeight = Math.max(10, Math.min(24, options.height - 12));
    const { lines, merged } = renderCandleChart(options.candles, {
      width: options.width, height: chartHeight, volumeHeight: 0, color: options.color, live: detail.active ? prices.live ?? prices.current : undefined,
      levels, band: [prices.lower, prices.upper], marks: detail.events.map((event) => ({ timestamp: event.timestamp, glyph: glyphs[event.kind]![0], color: glyphs[event.kind]![1] })),
    });
    out.push(paint.bold(`Price · ${detail.unit}`) + paint.dim(` · ${options.timeframe ?? ''} candles${merged > 1 ? `, ${merged} per column` : ''} · ${time(options.candles[0]!.timestamp)} – ${time(options.candles.at(-1)!.timestamp)} UTC`));
    out.push(...lines);
    out.push(paint.dim('   ·· range   ╌ limits, entry, exit and breakeven   ▲ deposit  $ fee collect  ▼ withdrawal'), '');
  } else if (options.plot && options.dataNote) out.push(paint.dim(`Price chart unavailable: ${options.dataNote}.`), '');

  if (options.plot && detail.curve.length) {
    const width = options.width;
    const lines = renderLineChart([
      { points: detail.curve.map((point) => [point.price, point.hodl]), color: 'yellow', dashed: true },
      { points: detail.curve.map((point) => [point.price, point.value]), color: 'blue' },
    ], {
      width, height: Math.max(8, Math.min(14, Math.round(options.height / 3))), color: options.color,
      markers: [
        { x: prices.lower, label: 'lower', color: 'green' }, { x: prices.upper, label: 'upper', color: 'green' },
        ...(prices.entry !== undefined ? [{ x: prices.entry, label: 'entry', color: 'cyan' as TermColor }] : []),
        ...((detail.active ? prices.live ?? prices.current : prices.exit) !== undefined ? [{ x: (detail.active ? prices.live ?? prices.current : prices.exit)!, label: detail.active ? 'now' : 'exit', color: (detail.active ? 'yellow' : 'magenta') as TermColor }] : []),
      ],
    });
    const source = detail.liquidity.curveFrom === 'deposit' ? 'the liquidity it was opened with' : 'its liquidity';
    out.push(paint.bold(`Value against price · ${detail.quote.symbol}`));
    out.push(...wrap(`The position with ${source} (blue) against holding the tokens it had at ${detail.curveReference === prices.entry ? 'entry' : 'the current price'} (yellow, dashed).`, options.width).map(paint.dim));
    out.push(...lines, '');
  }

  const quote = detail.quote.symbol;
  const base = detail.base.symbol;
  const groups: Array<[string, Array<[string, string]>]> = [];
  groups.push(['Range', [
    ['Lower', `${formatNumber(prices.lower)}${prices.toLowerPct !== undefined && detail.active ? paint.dim(` (${signed(prices.toLowerPct, 1)})`) : ''}`],
    ['Upper', `${formatNumber(prices.upper)}${prices.toUpperPct !== undefined && detail.active ? paint.dim(` (${signed(prices.toUpperPct, 1)})`) : ''}`],
    ['Price now', formatNumber(prices.live ?? prices.current)],
    ['Entry', `${formatNumber(prices.entry)}${prices.averageEntry !== undefined && prices.averageEntry !== prices.entry ? paint.dim(` (avg ${formatNumber(prices.averageEntry)})`) : ''}`],
    ...(detail.active ? [] : [['Exit', formatNumber(prices.exit)] as [string, string]]),
    ['Width', `${prices.widthPct.toFixed(2)}%${prices.lowerFromEntryPct !== undefined ? paint.dim(` (${signed(prices.lowerFromEntryPct, 1)} / ${signed(prices.upperFromEntryPct, 1)} from entry)`) : ''}`],
    ['Ticks', `${detail.tickLower} → ${detail.tickUpper}${detail.currentTick !== undefined ? paint.dim(` (now ${detail.currentTick})`) : ''}${detail.tickSpacing ? paint.dim(` · spacing ${detail.tickSpacing}`) : ''}`],
    ['Concentration', detail.liquidity.efficiency === undefined ? MISSING : `${detail.liquidity.efficiency.toFixed(1)}× full range${detail.active ? '' : paint.dim(' (at entry)')}`],
  ]]);
  const pair = (side: { base?: number; quote?: number }) => side.base === undefined || side.quote === undefined ? MISSING : `${formatNumber(side.base)} ${base} + ${formatNumber(side.quote)} ${quote}`;
  if (detail.active) {
    groups.push(['Holdings', [
      [base, amount(detail.holdings.base, '')],
      [quote, amount(detail.holdings.quote, '')],
      ['Value', `${formatUsd(detail.holdings.valueUsd)}${detail.holdings.valueQuote !== undefined ? paint.dim(` (${formatNumber(detail.holdings.valueQuote)} ${quote})`) : ''}`],
      ['Split', detail.holdings.baseSharePct === undefined ? MISSING : `${detail.holdings.baseSharePct.toFixed(1)}% ${base} / ${(100 - detail.holdings.baseSharePct).toFixed(1)}% ${quote}`],
      ['Unclaimed fees', `${formatUsd(flows.uncollected.usd)}${flows.uncollected.base !== undefined ? paint.dim(` (${pair(flows.uncollected)})`) : ''}`],
      ...(detail.historyAvailable ? [['Deposited', pair(flows.deposited)] as [string, string], ['Fees collected', pair(flows.collected)] as [string, string]] : []),
      ['Liquidity', detail.liquidity.raw],
    ]]);
  } else {
    groups.push(['Tokens', [
      ['Deposited', `${pair(flows.deposited)}${paint.dim(` (${formatUsd(flows.deposited.usd)})`)}`],
      ['Withdrawn', `${pair(flows.withdrawn)}${paint.dim(` (${formatUsd(flows.withdrawn.usd)})`)}`],
      ['Fees collected', `${pair(flows.collected)}${paint.dim(` (${formatUsd(flows.collected.usd)})`)}`],
      ['Net change', [[flows.withdrawn.base + flows.collected.base - flows.deposited.base, base], [flows.withdrawn.quote + flows.collected.quote - flows.deposited.quote, quote]].map(([value, symbol]) => `${(value as number) >= 0 ? '+' : '−'}${formatNumber(Math.abs(value as number))} ${symbol}`).join('  ')],
    ]]);
  }
  if (detail.historyAvailable) {
    groups.push(['Performance', [
      ['Deposited', formatUsd(perf.depositedUsd)],
      ['Withdrawn', formatUsd(perf.withdrawnUsd)],
      ['Fees earned', `${formatUsd(perf.feesUsd)}${perf.feesPerDayUsd !== undefined ? paint.dim(` (${formatUsd(perf.feesPerDayUsd)}/day)`) : ''}`],
      ['Gas', formatUsd(perf.gasUsd)],
      ['PnL', `${formatSignedUsd(perf.pnlUsd)}${perf.pnlPct !== undefined ? ` (${signed(perf.pnlPct)})` : ''}`],
      ['Impermanent loss', `${formatSignedUsd(perf.ilUsd)}${perf.feesCoverIlPct !== undefined ? paint.dim(` · fees cover ${perf.feesCoverIlPct.toFixed(0)}%`) : ''}`],
      ['vs holding', perf.hodlUsd === undefined ? MISSING : `${formatSignedUsd(perf.vsHodlUsd)}${paint.dim(` (hold: ${formatUsd(perf.hodlUsd)})`)}`],
      ['Fee APR', formatPercent(perf.feeAprPct)],
      ['Total APR', perf.totalAprPct === undefined ? MISSING : signed(perf.totalAprPct)],
      ...(perf.breakeven !== undefined ? [['Breakeven', `above ${formatNumber(perf.breakeven)}`] as [string, string]] : []),
    ]]);
  }
  groups.push(['Time', [
    ['Opened', iso(detail.openedAt)],
    ...(detail.closedAt ? [['Closed', iso(detail.closedAt)] as [string, string]] : []),
    ['Held', days(perf.daysHeld)],
    ...(history ? [
      ['Time in range', history.inRangePct === undefined ? MISSING : `${history.inRangePct.toFixed(1)}%${paint.dim(` (${history.timeframe} closes)`)}`],
      ['Range exits', history.exits === undefined ? MISSING : String(history.exits)],
      ['High / low', `${formatNumber(history.high)} / ${formatNumber(history.low)}`],
      ['Volatility', history.volatilityPct === undefined ? MISSING : `${history.volatilityPct.toFixed(0)}%/yr${history.dailyVolatilityPct !== undefined ? paint.dim(` (chart ${history.dailyVolatilityPct.toFixed(2)}%/day)`) : ''}`],
      ...(history.daysToLower !== undefined || history.daysToUpper !== undefined ? [['Typical time to limit', `lower ${days(history.daysToLower)} · upper ${days(history.daysToUpper)}`] as [string, string]] : []),
    ] as Array<[string, string]> : []),
  ]]);
  out.push(...sections(groups, options.width, options.color));

  if (detail.scenarios.length) {
    const columns: Column[] = [{ header: 'Price move' }, { header: 'Price', align: 'right' }, { header: base, align: 'right' }, { header: quote, align: 'right' },
      { header: 'Value', align: 'right' }, { header: 'vs holding', align: 'right' }, ...(detail.scenarios.some((row) => row.pnlUsd !== undefined) ? [{ header: 'Lifetime PnL', align: 'right' as const }] : []), { header: 'Range' }];
    out.push(paint.bold('What if the price moved now') + paint.dim(` · fees earned so far included; ${quote} at today's USD price`));
    out.push(renderTable(columns, detail.scenarios.map((row) => [
      row.label, formatNumber(row.price), formatNumber(row.base), formatNumber(row.quote), formatUsd(row.valueUsd), signed(row.vsHodlPct),
      ...(columns.some((column) => column.header === 'Lifetime PnL') ? [formatSignedUsd(row.pnlUsd)] : []), row.inRange ? 'in' : 'out',
    ])), '');
  }

  if (detail.events.length) {
    const names = { deposit: 'Deposit', withdraw: 'Withdraw', collect: 'Collect fees' };
    out.push(paint.bold(`Transactions (${detail.events.length})`));
    const table = (full: boolean) => renderTable([{ header: 'Time (UTC)' }, { header: 'Action' }, { header: base, align: 'right' }, { header: quote, align: 'right' }, { header: 'Price', align: 'right' }, { header: 'Value', align: 'right' }, { header: 'Gas', align: 'right' }, { header: 'Transaction' }],
      detail.events.map((event) => [time(event.timestamp), names[event.kind], formatNumber(event.base), formatNumber(event.quote), formatNumber(event.displayPrice), formatUsd(event.valueUsd), event.gasUsd === undefined ? MISSING : formatUsd(event.gasUsd),
        event.hash ? (full ? txLink(detail.chainId, event.hash) ?? event.hash : `${event.hash.slice(0, 10)}…${event.hash.slice(-6)}`) : MISSING]));
    // Full explorer links when they fit (terminals make them clickable); short hashes otherwise.
    const wide = table(true);
    out.push(wide.split('\n').every((line) => line.length <= options.width) ? wide : table(false), '');
  }

  const notes = [`Prices are ${detail.unit}. Age ${formatAge(detail.openedAt)}.`];
  if (detail.historyAvailable) notes.push('PnL: value + withdrawals + fees − deposits − gas, each in USD when it happened. Impermanent loss excludes fees. vs holding: what the position returned (with fees, after gas) minus the deposited tokens held instead.');
  else notes.push('On-chain data only: deposits, withdrawals, fees earned, PnL and dates are unknown.');
  if (history?.daysToLower !== undefined) notes.push('Typical time to limit: (distance ÷ daily volatility)² days, how long a random walk usually takes to move that far; not a forecast.');
  if (options.dataNote && options.candles?.length) notes.push(options.dataNote);
  if (detail.links.position) notes.push(`Uniswap: ${detail.links.position}`);
  out.push(...wrap(notes.join('\n'), options.width).map(paint.dim));
  return out.join('\n');
}

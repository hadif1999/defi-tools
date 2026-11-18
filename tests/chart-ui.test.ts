import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChartHtml } from '../src/html-chart.js';
import { showStats, type ShowView } from '../src/dex-show.js';
import type { Candle } from '../src/dex-data.js';
import { browser, Page, sleep } from './helpers/browser.js';

// Drives the HTML chart workspace in headless Chrome with real mouse and keyboard events (DevTools protocol).
// Runs when Chrome or Chromium is installed (or CHROME_PATH is set); skipped otherwise.


const H = 3_600;
function fixture(): ShowView {
  // 300 hourly candles of a gentle wave, with one quiet hour.
  const candles: Candle[] = Array.from({ length: 300 }, (_, i) => {
    const open = 2_000 + Math.sin(i / 12) * 80 + i * 0.5;
    const close = 2_000 + Math.sin((i + 1) / 12) * 80 + (i + 1) * 0.5;
    return { timestamp: 1_790_000_000 - (1_790_000_000 % H) + i * H, open, close, high: Math.max(open, close) + 6, low: Math.min(open, close) - 6, volume: 1_000 + (i % 24) * 50, filled: i === 150 };
  });
  return {
    pair: 'WETH/USDC', poolLabel: 'Uniswap v3 0.05%', chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', priceUnit: 'USDC per WETH', volumeUnit: 'USDC',
    timeframe: '1h', step: H, candles, stats: showStats(candles, H), tickerNote: 'offline', sources: { cached: ['a.csv'], downloaded: [], unavailable: [], requests: 0 },
  };
}



test('the chart workspace draws, drags, edits and remembers like a trading terminal', { skip: browser ? false : 'Chrome or Chromium is not installed', timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-chart-ui-'));
  const file = join(directory, 'chart.html');
  writeFileSync(file, buildChartHtml(fixture()));
  let chrome: ChildProcess | undefined;
  let ws: WebSocket | undefined;
  try {
    chrome = spawn(browser!, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`, '--window-size=1400,850', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(directory, 'profile', 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>).find((item) => item.type === 'page')!;
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => ws!.addEventListener('open', resolve, { once: true }));
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `file://${file}` });
    for (let i = 0; i < 50 && !(await page.eval<boolean>('Boolean(window.chartApp)')); i += 1) await sleep(100);
    await sleep(300);
    const box = await page.eval<{ left: number; top: number; width: number; height: number }>(`(() => { const r = document.getElementById('chart-area').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    const at = (fx: number, fy: number) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy });

    // Hovering shows the candle's values; the legend follows the crosshair.
    await page.mouse('mouseMoved', at(0.4, 0.4).x, at(0.4, 0.4).y); await sleep(100);
    const first = await page.eval<string>(`document.querySelector('#legend .line:nth-child(2)').innerText`);
    await page.mouse('mouseMoved', at(0.6, 0.4).x, at(0.6, 0.4).y); await sleep(100);
    const second = await page.eval<string>(`document.querySelector('#legend .line:nth-child(2)').innerText`);
    assert.match(first, /O\s+[\d,.]+\s+H\s+[\d,.]+\s+L\s+[\d,.]+\s+C\s+[\d,.]+/);
    assert.notEqual(first, second);

    // In cursor mode, dragging the chart pans it.
    const before = await page.eval<{ from: number }>('chartApp.visible()');
    await page.drag(at(0.5, 0.75), at(0.7, 0.75));
    assert.ok(Math.abs((await page.eval<{ from: number }>('chartApp.visible()')).from - before.from) > 3, 'pans');

    // A trend line by click-drag: selected, style bar open, and the chart did not pan.
    await page.click(await page.center('[data-tool="trend"]'));
    const still = await page.eval<{ from: number }>('chartApp.visible()');
    await page.drag(at(0.3, 0.6), at(0.55, 0.35));
    let drawings = await page.eval<Array<{ id: string; type: string; points: Array<{ t: number; p: number }>; color: string; extend?: string }>>('chartApp.drawings');
    assert.equal(drawings.length, 1);
    assert.equal(drawings[0]!.type, 'trend');
    assert.equal((await page.eval<{ from: number }>('chartApp.visible()')).from, still.from);
    assert.equal(await page.eval('chartApp.tool'), 'cursor');
    assert.equal(await page.eval('chartApp.selectedId'), drawings[0]!.id);
    assert.ok(await page.eval(`document.getElementById('float-bar').classList.contains('open')`));

    // Dragging the body moves both points; dragging a handle moves one.
    const [a, b] = drawings[0]!.points;
    const middle = await page.eval<{ x: number; y: number }>(`(() => { const a = chartApp.toScreen(${a!.t}, ${a!.p}); const b = chartApp.toScreen(${b!.t}, ${b!.p}); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; })()`);
    await page.drag(middle, { x: middle.x + 50, y: middle.y + 30 });
    const moved = (await page.eval<typeof drawings>('chartApp.drawings'))[0]!.points;
    assert.ok(moved[0]!.t > a!.t && moved[1]!.t > b!.t && moved[0]!.p < a!.p, 'body drag');
    const handle = await page.eval<{ x: number; y: number }>(`chartApp.toScreen(${moved[1]!.t}, ${moved[1]!.p})`);
    await page.drag(handle, { x: handle.x + 30, y: handle.y - 50 });
    const reshaped = (await page.eval<typeof drawings>('chartApp.drawings'))[0]!.points;
    assert.deepEqual(reshaped[0], moved[0]);
    assert.ok(reshaped[1]!.p > moved[1]!.p, 'handle drag');

    // The style bar changes the selection; Delete, Ctrl+Z and Ctrl+Y work.
    await page.click(await page.center('#float-bar [data-color="#f23645"]'));
    await page.click(await page.center('#float-bar [data-extend]'));
    drawings = await page.eval('chartApp.drawings');
    assert.deepEqual([drawings[0]!.color, drawings[0]!.extend], ['#f23645', 'right']);
    await page.key('Delete', 'Delete');
    assert.equal((await page.eval<unknown[]>('chartApp.drawings')).length, 0);
    await page.key('z', 'KeyZ', 2);
    assert.equal((await page.eval<unknown[]>('chartApp.drawings')).length, 1);
    await page.key('y', 'KeyY', 2);
    assert.equal((await page.eval<unknown[]>('chartApp.drawings')).length, 0);
    await page.key('z', 'KeyZ', 2);

    // Shortcuts: Fibonacci by click-click, a long position by one click.
    await page.key('f', 'KeyF', 1);
    assert.equal(await page.eval('chartApp.tool'), 'fib');
    await page.click(at(0.2, 0.7)); await page.mouse('mouseMoved', at(0.35, 0.3).x, at(0.35, 0.3).y); await page.click(at(0.35, 0.3));
    await page.key('l', 'KeyL', 1); await page.click(at(0.65, 0.5));
    drawings = await page.eval('chartApp.drawings');
    assert.deepEqual(drawings.map((d) => d.type).sort(), ['fib', 'long', 'trend']);
    assert.equal(drawings.find((d) => d.type === 'long')!.points.length, 3);

    // Indicators from the menu, with their values in the legend.
    await page.click(await page.center('#indicators-button'));
    for (const key of ['ma', 'rsi']) await page.click(await page.center(`#indicators-menu input[type="checkbox"][data-ind="${key}"]`));
    await page.key('Escape', 'Escape');
    assert.deepEqual(await page.eval('chartApp.series'), ['volume', 'ma', 'rsi']);
    await page.mouse('mouseMoved', at(0.5, 0.3).x, at(0.5, 0.3).y); await sleep(100);
    assert.match(await page.eval<string>(`document.getElementById('legend').innerText`), /MA 20\s+[\d,.]+[\s\S]*RSI 14\s+[\d.]+/);

    // Every timeframe, up and back down: each bar matches an independent resampling, the view keeps the same
    // moment in the middle (even from weekly bars down to hourly ones), and the drawings stay as they are.
    const candles = fixture().candles;
    const reference = (size: number) => {
      const offset = size === 604_800 ? 4 * 86_400 : 0;
      const groups = new Map<number, Candle[]>();
      for (const c of candles) { const key = Math.floor((c.timestamp - offset) / size) * size + offset; groups.set(key, [...(groups.get(key) ?? []), c]); }
      return [...groups].map(([time, list]) => ({ time, open: list[0]!.open, high: Math.max(...list.map((c) => c.high)), low: Math.min(...list.map((c) => c.low)), close: list.at(-1)!.close }));
    };
    const middleTime = async () => {
      const range = await page.eval<{ from: number; to: number }>('chartApp.visible()');
      const shown = await page.eval<number[]>('chartApp.mainData().map((d) => d.time)');
      return shown[Math.max(0, Math.min(shown.length - 1, Math.round((range.from + range.to) / 2)))]!;
    };
    const kept = JSON.stringify(await page.eval('chartApp.drawings'));
    const sizes = (await page.eval<Array<{ size: number }>>('chartApp.timeframes')).map((item) => item.size);
    assert.deepEqual(sizes, [3_600, 7_200, 14_400, 43_200, 86_400, 604_800]);
    for (const size of [...sizes, ...[...sizes].reverse()]) {
      const before = await middleTime();
      const previous = await page.eval<number>('chartApp.step');
      await page.click(await page.center(`#timeframes [data-size="${size}"]`));
      const plotted = await page.eval<Array<{ time: number; open: number; high: number; low: number; close: number }>>('chartApp.mainData()');
      const expected = reference(size);
      assert.equal(plotted.length, expected.length, `${size}: bars`);
      plotted.forEach((bar, i) => {
        const want = expected[i]!;
        assert.ok(bar.time === want.time && [bar.open - want.open, bar.high - want.high, bar.low - want.low, bar.close - want.close].every((d) => Math.abs(d) < 1e-9), `${size}: bar ${i}`);
      });
      assert.ok(Math.abs(await middleTime() - before) <= Math.max(size, previous) * 1.5, `${size}: the view kept its moment`);
      assert.equal(JSON.stringify(await page.eval('chartApp.drawings')), kept);
    }

    // Chart type changes keep the drawings; a reload restores everything.
    await page.click(await page.center('#timeframes [data-size="14400"]'));
    assert.equal(await page.eval('chartApp.step'), 14_400);
    assert.equal((await page.eval<unknown[]>('chartApp.drawings')).length, 3);
    await page.click(await page.center('#type-button'));
    await page.click(await page.center('#type-menu [data-type="bars"]'));
    await page.send('Page.reload'); await sleep(1_500);
    assert.deepEqual(await page.eval('({ drawings: chartApp.drawings.length, series: chartApp.series, type: chartApp.type })'), { drawings: 3, series: ['volume', 'ma', 'rsi'], type: 'bars' });
    assert.deepEqual(page.errors, []);
  } finally {
    ws?.close();
    chrome?.kill();
    await sleep(200);
    rmSync(directory, { recursive: true, force: true });
  }
});

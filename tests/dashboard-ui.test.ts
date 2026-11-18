import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_URL } from '../src/config.js';
import { startDashboard } from '../src/dashboard/server.js';
import { Store } from '../src/storage.js';
import { browser, launch, sleep, type Page } from './helpers/browser.js';
import { closedArbitrum, closedEthereum, openBase, WALLET } from './fixtures/revert.js';

// Drives the dashboard in headless Chrome: sign-in by link, the overview and positions from a Revert fixture, the
// position page, adding a wallet through its form, the wallet picker, the command palette and the theme.
// Runs when Chrome or Chromium is installed (or CHROME_PATH is set); skipped otherwise.

const until = async (page: Page, expression: string, what: string, ms = 10_000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await page.eval<boolean>(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}: ${await page.eval<string>('document.querySelector("main")?.innerText.slice(0, 400)')}`);
};
const text = (page: Page, selector: string) => page.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

test('the dashboard signs in by link, shows positions and wallets, and saves a wallet from its form', { skip: browser ? false : 'Chrome or Chromium is not installed', timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-ui-'));
  const revert = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: req.url!.startsWith(`/v1/positions/uniswapv3/account/${WALLET}`) ? [closedArbitrum, openBase, closedEthereum] : [], pagination: { next_cursor: null } }));
  });
  await new Promise<void>((resolve) => revert.listen(0, '127.0.0.1', resolve));
  process.env.DEFI_TOOL_REVERT_URL = `http://127.0.0.1:${(revert.address() as { port: number }).port}`;
  const databasePath = join(directory, 'state.db');
  const store = new Store(databasePath);
  store.addWallet({ name: 'ledger', address: WALLET, chainId: 42161 });
  store.close();
  const app = await startDashboard({
    config: { apiUrl: DEFAULT_API_URL, rpcUrls: { 8453: 'http://127.0.0.1:9', 42161: 'http://127.0.0.1:9', 1: 'http://127.0.0.1:9' }, chains: [1, 8453, 42161], wallets: [], databasePath, saturationThresholdPct: 0.1, dataTtlSeconds: 60 },
    port: 0, host: '127.0.0.1', dataDir: join(directory, 'dex-data'), marketDir: join(directory, 'market-data'), refreshMs: 60_000, offline: true,
  });
  let chrome: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    chrome = await launch(directory);
    const { page } = chrome;

    // The link with the token signs in, then the token leaves the address bar.
    await page.send('Page.navigate', { url: app.loginUrl });
    await until(page, `document.querySelector('.kpi .value') && !document.querySelector('.kpi .skeleton')`, 'the overview figures');
    assert.equal(await page.eval('location.search'), '');
    assert.equal(await page.eval('document.title'), 'Overview · defi-tool');
    const kpis = await text(page, '.kpis');
    assert.match(kpis, /Open value/);
    assert.match(kpis, /Lifetime fees/);
    assert.match(await text(page, '.page-head'), /ledger \(0x902e…3f00\) on all networks/);
    assert.match(await text(page, '#top'), /Default · ledger/);
    await until(page, `[...document.querySelectorAll('.card')].some((card) => card.innerText.includes('WETH/USDC'))`, 'the open position on the overview');

    // Positions: the closed table, sorted by a click on a header, and a row opening the position page.
    await page.eval(`location.hash = '#/positions?tab=past'`);
    await until(page, `document.querySelectorAll('table.t tbody tr').length === 2`, 'two closed positions');
    assert.match(await text(page, 'table.t thead'), /EXIT PRICE/i);
    await page.click(await page.center('table.t th.sortable:nth-child(2)'));
    const ids = await page.eval<string[]>(`[...document.querySelectorAll('table.t tbody tr td:nth-child(2)')].map((cell) => cell.innerText)`);
    assert.deepEqual([...ids].sort(), ['#1373723', '#5723933']);
    await page.click(await page.center('table.t tbody tr'));
    await until(page, `location.hash.startsWith('#/position?')`, 'the position page');
    await until(page, `document.querySelector('.page-head h1')?.innerText.includes('Closed')`, 'the position summary');
    assert.match(await text(page, '.kpis'), /PnL/);
    await until(page, `document.querySelector('iframe.frame')`, 'the position report frame');

    // Wallets: add one through the form; a mistake shows the server's message on its field.
    await page.eval(`location.hash = '#/wallets?add=1'`);
    await until(page, `document.querySelector('.modal input[name="address"]')`, 'the add-wallet form');
    await page.eval(`(() => { const set = (name, value) => { const node = document.querySelector('.modal [name="' + name + '"]'); node.value = value; };
      set('address', '0x12'); set('chain', 'base'); set('name', 'savings'); })()`);
    await page.click(await page.center('.modal footer .btn.primary'));
    await until(page, `document.querySelector('.modal .field .error:not([hidden])')`, 'the address error');
    assert.match(await text(page, '.modal'), /not a valid Base address/);
    await page.eval(`document.querySelector('.modal [name="address"]').value = '0x1111111111111111111111111111111111111111'`);
    await page.click(await page.center('.modal footer .btn.primary'));
    await until(page, `!document.querySelector('.modal') && [...document.querySelectorAll('table.t tbody tr')].some((row) => row.innerText.includes('savings'))`, 'the new wallet in the table');
    const reader = new Store(databasePath);
    assert.equal(reader.wallet('savings')?.chainId, 8453);
    reader.close();

    // The wallet picker reads every saved wallet; the choice is kept in this browser.
    await page.click(await page.center('#top .picker .btn'));
    await until(page, `document.querySelector('.popover')`, 'the wallet picker');
    await page.eval(`[...document.querySelectorAll('.popover .option')].find((option) => option.innerText.includes('All saved wallets')).querySelector('input').click()`);
    await page.eval(`[...document.querySelectorAll('.popover .btn.primary')].find((button) => button.innerText === 'Apply').click()`);
    await until(page, `document.querySelector('#top').innerText.includes('All wallets')`, 'the picker label');
    assert.equal(JSON.parse(await page.eval<string>(`localStorage.getItem('defi-tool:dashboard:wallets')`)).mode, 'all');

    // Command palette (Ctrl+K) and theme (t) from the keyboard.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    await until(page, `document.querySelector('.palette input')`, 'the command palette');
    await page.eval(`(() => { const input = document.querySelector('.palette input'); input.value = 'alerts'; input.dispatchEvent(new Event('input')); })()`);
    assert.match(await text(page, '.palette ul'), /Go to Alerts/);
    await page.key('Escape', 'Escape');
    await until(page, `!document.querySelector('.palette')`, 'the palette to close');
    const before = await page.eval<string>(`document.documentElement.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')`);
    await page.key('t', 'KeyT');
    await until(page, `document.documentElement.getAttribute('data-theme') === ${JSON.stringify(before === 'dark' ? 'light' : 'dark')}`, 'the other theme');
    assert.equal(await page.eval(`localStorage.getItem('defi-tool:dashboard:theme')`), before === 'dark' ? 'light' : 'dark');

    // Every page opens without a script error.
    for (const route of ['overview', 'positions', 'markets', 'alerts', 'pools', 'plan', 'wallets', 'data', 'settings']) {
      await page.eval(`location.hash = '#/${route}'`);
      await until(page, `document.querySelector('.view h1')`, `the ${route} page`);
    }
    assert.deepEqual(page.errors, []);
  } finally {
    chrome?.close();
    delete process.env.DEFI_TOOL_REVERT_URL;
    await app.close();
    await new Promise<void>((resolve) => revert.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_API_URL } from '../src/config.js';
import { startDashboard, type RunningDashboard } from '../src/dashboard/server.js';
import { TtlCache } from '../src/dashboard/cache.js';
import { Router } from '../src/dashboard/http.js';
import { allowedHosts, withNonce } from '../src/dashboard/security.js';
import { parseTickerKey } from '../src/dashboard/events.js';
import type { AppConfig } from '../src/types.js';
import { closedArbitrum, closedEthereum, openBase, WALLET } from './fixtures/revert.js';

// The dashboard server end to end, in process: access control, the API over the same services as the CLI, jobs, events
// and files. Upstream services are local fixtures (Revert) or unreachable ports, so nothing leaves the machine.

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };

function config(directory: string): AppConfig {
  return {
    apiUrl: DEFAULT_API_URL, rpcUrls: { 1: 'http://127.0.0.1:9', 8453: 'http://127.0.0.1:9', 42161: 'http://127.0.0.1:9', 10: 'http://127.0.0.1:9', 137: 'http://127.0.0.1:9' },
    chains: [1, 10, 137, 8453, 42161], wallets: [], databasePath: join(directory, 'state.db'), saturationThresholdPct: 0.1, dataTtlSeconds: 60,
  };
}

async function revertFixture(): Promise<{ server: Server; url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('content-type', 'application/json');
    const rows = req.url!.startsWith(`/v1/positions/uniswapv3/account/${WALLET}`) ? [closedArbitrum, openBase, closedEthereum] : [];
    res.end(JSON.stringify({ success: true, data: rows, pagination: { next_cursor: null } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

async function start(directory: string, options: Partial<Parameters<typeof startDashboard>[0]> = {}): Promise<RunningDashboard> {
  return startDashboard({ config: config(directory), port: 0, host: '127.0.0.1', token: TOKEN, dataDir: join(directory, 'dex-data'), marketDir: join(directory, 'market-data'), refreshMs: 60_000, offline: true, ...options });
}

/** A raw request, so Host and other headers fetch() fixes can be set. */
function raw(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> & { data?: any; error?: { message: string; code: string } } });

test('access needs the token, the right Host, and same-origin writes; the token link becomes a session cookie', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-auth-'));
  const app = await start(directory);
  try {
    assert.equal((await fetch(`${app.url}api/meta`)).status, 401);
    assert.equal((await fetch(`${app.url}api/meta`, { headers: { authorization: 'Bearer wrong-token-0123456789abc' } })).status, 401);
    assert.equal((await fetch(`${app.url}api/meta`, { headers: auth })).status, 200);

    // A browser without the token gets the locked page, not the app.
    const locked = await fetch(app.url);
    assert.equal(locked.status, 401);
    assert.match(await locked.text(), /Access token required/);

    // DNS rebinding: a foreign Host is refused even with the token.
    const rebound = await raw(`${app.url}api/meta`, { headers: { ...auth, host: 'evil.example:80' } });
    assert.equal(rebound.status, 421);
    assert.match(rebound.body, /does not answer to host/);
    assert.equal((await raw(`${app.url}api/meta`, { headers: { ...auth, host: `localhost:${app.port}` } })).status, 200);

    // The one-time link: a cookie, and a redirect that drops the token from the address bar.
    const login = await fetch(app.loginUrl, { redirect: 'manual' });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/');
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const page = await fetch(app.url, { headers: { cookie: cookie.split(';')[0]! } });
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy')!;
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /<script type="module" src="\/js\/main\.js">/);
    assert.equal((await fetch(`${app.loginUrl.replace(TOKEN, 'nope-nope-nope-nope-nope')}`, { redirect: 'manual' })).status, 401);

    // Writes from another origin or site are refused, even with the token.
    const body = JSON.stringify({ address: WALLET, chain: 'base' });
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }] as Array<Record<string, string>>) {
      const refused = await fetch(`${app.url}api/wallets`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body });
      assert.equal(refused.status, 403);
    }
    assert.equal((await fetch(`${app.url}api/wallets`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin: app.url.slice(0, -1) }, body })).status, 200);

    // Static files stay inside assets/dashboard; public assets need no token.
    assert.equal((await raw(`${app.url}..%2f..%2fpackage.json`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${app.url}app.css`)).status, 200);
    assert.equal((await fetch(`${app.url}js/main.js`)).status, 401);
    const vendor = await fetch(`${app.url}vendor/lightweight-charts.js`, { headers: auth });
    assert.equal(vendor.status, 200);
    assert.match(await vendor.text(), /LightweightCharts/);
    // App paths typed into the address bar go back to the shell; unknown API paths and methods get JSON errors.
    assert.equal((await fetch(`${app.url}positions`, { headers: auth, redirect: 'manual' })).status, 302);
    assert.equal((await json(await fetch(`${app.url}api/nothing`, { headers: auth }))).body.error!.code, 'not_found');
    const wrongMethod = await fetch(`${app.url}api/meta`, { method: 'DELETE', headers: auth });
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.headers.get('allow')!, /GET/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wallets: add, validate, rename, choose the default and delete, with the CLI\'s rules and messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-wallets-'));
  const app = await start(directory);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${app.url}${path}`, { method, headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }).then(json);
  try {
    let result = await call('POST', 'api/wallets', { address: WALLET.toUpperCase().replace('0X', '0x'), chain: 'base', name: 'main' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.address, WALLET);
    assert.equal(result.body.data.default, true);
    result = await call('POST', 'api/wallets', { address: '0x1111111111111111111111111111111111111111', chain: 'eth' });
    assert.equal(result.body.data.name, 'wallet0');

    for (const [body, pattern] of [
      [{ address: '0x12', chain: 'base' }, /not a valid Base address/],
      [{ address: WALLET, chain: 'base', name: 'other' }, /already saved for that network as "main"/],
      [{ address: WALLET, chain: 'eth', name: 'all' }, /"all" is reserved/],
      [{ address: WALLET, chain: 'eth,base' }, /--chain takes one network/],
      [{ chain: 'base' }, /address: Required/],
    ] as const) {
      const failed = await call('POST', 'api/wallets', body);
      assert.equal(failed.status, 400, JSON.stringify(body));
      assert.match(failed.body.error!.message, pattern);
    }
    assert.equal((await call('POST', 'api/wallets', '{not json')).status, 400);
    assert.equal((await call('POST', 'api/wallets', 'x'.repeat(1_100_000))).status, 413);
    assert.equal((await call('POST', 'api/wallets', '{}', { 'content-type': 'text/plain' })).status, 415);

    result = await call('PATCH', 'api/wallets/MAIN', { name: 'trading' });
    assert.equal(result.body.data.name, 'trading');
    assert.equal((await call('PATCH', 'api/wallets/nobody', { name: 'x' })).status, 400);
    result = await call('PUT', 'api/wallets/default', { wallet: '2' });
    assert.equal(result.body.data.name, 'wallet0');
    const listed = await call('GET', 'api/wallets');
    assert.deepEqual(listed.body.data.map((wallet: { name: string; default: boolean; chosenDefault: boolean }) => [wallet.name, wallet.default, wallet.chosenDefault]), [['trading', false, false], ['wallet0', true, true]]);
    assert.deepEqual((await call('GET', 'api/meta')).body.data.defaultWallet, { name: 'wallet0', chosen: true });
    assert.equal((await call('PUT', 'api/wallets/default', { wallet: 'all' })).status, 400);

    result = await call('DELETE', 'api/wallets/wallet0');
    assert.equal(result.body.data.name, 'wallet0');
    assert.deepEqual((await call('GET', 'api/meta')).body.data.defaultWallet, { name: 'trading', chosen: false });
    assert.equal((await call('DELETE', 'api/wallets/wallet0')).status, 400);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('read-only mode refuses every change but keeps reading', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-readonly-'));
  const app = await start(directory, { readOnly: true });
  try {
    const add = await json(await fetch(`${app.url}api/wallets`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ address: WALLET, chain: 'base' }) }));
    assert.equal(add.status, 403);
    assert.equal(add.body.error!.code, 'read_only');
    for (const [method, path] of [['DELETE', 'api/wallets/x'], ['PUT', 'api/wallets/default'], ['POST', 'api/alerts/check'], ['POST', 'api/downloads/market']]) {
      assert.equal((await fetch(`${app.url}${path}`, { method, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pairs: 'ETH' }) })).status, 403, `${method} ${path}`);
    }
    assert.equal((await json(await fetch(`${app.url}api/meta`, { headers: auth }))).body.data.dashboard.readOnly, true);
    assert.equal((await fetch(`${app.url}api/wallets`, { headers: auth })).status, 200);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('positions come from the same service as positions list, summarized, and cached until refreshed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-positions-'));
  const revert = await revertFixture();
  process.env.DEFI_TOOL_REVERT_URL = revert.url;
  const app = await start(directory);
  try {
    const first = await json(await fetch(`${app.url}api/positions?walletAddr=${WALLET}`, { headers: auth }));
    assert.equal(first.status, 200);
    const data = first.body.data;
    assert.deepEqual(data.active.map((position: { id: string }) => position.id), ['999']);
    assert.deepEqual(data.past.map((position: { id: string }) => position.id), ['5723933', '1373723']);
    assert.equal(data.summary.open, 1);
    assert.equal(data.summary.closed, 2);
    assert.match(data.scope[0], /0x902e…3f00 on all networks/);
    assert.equal(data.source, 'Revert Finance (no API key)');
    assert.ok(Math.abs(data.summary.feesEarnedUsd - data.active.concat(data.past).reduce((sum: number, position: { feesEarnedUsd?: number }) => sum + (position.feesEarnedUsd ?? 0), 0)) < 1e-9);
    assert.equal(first.body.cached, false);

    const requests = revert.requests.length;
    const second = await json(await fetch(`${app.url}api/positions?walletAddr=${WALLET}`, { headers: auth }));
    assert.equal(second.body.cached, true);
    assert.equal(revert.requests.length, requests);
    const refreshed = await json(await fetch(`${app.url}api/positions?walletAddr=${WALLET}&refresh=1`, { headers: auth }));
    assert.equal(refreshed.body.cached, false);
    assert.ok(revert.requests.length > requests);

    // The CLI's own validation messages come back as 400s.
    const bad = await json(await fetch(`${app.url}api/positions?wallet=nobody`, { headers: auth }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error!.message, /No saved wallet named "nobody"/);
    const source = await json(await fetch(`${app.url}api/positions?walletAddr=${WALLET}&source=graph`, { headers: auth }));
    assert.equal(source.status, 400);
    assert.equal(source.body.error!.code, 'invalid_input');
  } finally {
    delete process.env.DEFI_TOOL_REVERT_URL;
    await app.close();
    await new Promise<void>((resolve) => revert.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('files: saved downloads are listed and served by name only, never by path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-files-'));
  const dexDir = join(directory, 'dex-data');
  mkdirSync(dexDir);
  const name = 'WETH-USDC_base_uniswap-v3-0.05_0xd0b53d_1h_20261001-0000_20261002-0000.csv';
  writeFileSync(join(dexDir, name), 'time,timestamp,open,high,low,close,volume,filled\n2026-10-01T00:00:00.000Z,1790812800,1,2,0.5,1.5,10,false\n');
  writeFileSync(join(dexDir, `${name}.meta.json`), JSON.stringify({
    source: 'geckoterminal', pair: 'WETH/USDC', pool: { chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', name: 'WETH / USDC 0.05%', dexId: 'uniswap-v3-base', dex: 'uniswap', version: 'v3', feeTier: 500 },
    pricedToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' }, quoteToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
    priceUnit: 'USDC per WETH', volumeUnit: 'USDC', timeframe: '1h', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', candles: 1, downloadedAt: '2026-10-02T00:00:00.000Z',
  }));
  writeFileSync(join(directory, 'secret.txt'), 'do not serve');
  const app = await start(directory);
  try {
    const listed = await json(await fetch(`${app.url}api/files`, { headers: auth }));
    assert.equal(listed.body.data.files.length, 1);
    assert.equal(listed.body.data.files[0].name, name);
    assert.equal(listed.body.data.files[0].chain, 'base');
    const file = await fetch(`${app.url}api/files/raw?kind=dex&name=${encodeURIComponent(name)}`, { headers: auth });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition')!, /attachment/);
    assert.match(await file.text(), /^time,timestamp/);
    assert.equal((await fetch(`${app.url}api/files/raw?kind=dex&name=${encodeURIComponent(`${name}.meta.json`)}`, { headers: auth })).status, 200);
    for (const bad of ['../secret.txt', '..%2Fsecret.txt', '.hidden', 'secret.txt', `sub/${name}`]) {
      const response = await fetch(`${app.url}api/files/raw?kind=dex&name=${bad}`, { headers: auth });
      assert.ok([400, 404].includes(response.status), `${bad}: ${response.status}`);
    }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('jobs run in the background, report through the event stream, and keep their result or error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-jobs-'));
  const app = await start(directory);
  const controller = new AbortController();
  try {
    // The event stream: hello first, then job events as they happen.
    const stream = await fetch(`${app.url}api/events?tickers=not-a-key`, { headers: auth, signal: controller.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = stream.body!.getReader();
    let text = '';
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
      return text;
    };
    await until(/event: ticker-error/);
    assert.match(text, /event: hello/);
    assert.match(text, /is not a ticker key/);

    // An alert check against an unreachable RPC: the job starts at once (202), then fails with the CLI's message.
    const started = await fetch(`${app.url}api/alerts/check`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ wallet: WALLET, chain: 'base' }) });
    assert.equal(started.status, 202);
    const job = (await started.json() as { data: { id: string; status: string } }).data;
    assert.equal(job.status, 'running');
    await until(new RegExp(`"id":"${job.id}"[^\\n]*"status":"failed"`));
    const finished = await json(await fetch(`${app.url}api/jobs/${job.id}`, { headers: auth }));
    assert.equal(finished.body.data.status, 'failed');
    assert.match(finished.body.data.error, /Position RPC reads failed for every wallet\/network/);
    assert.ok(finished.body.data.finishedAt);
    assert.equal((await json(await fetch(`${app.url}api/jobs`, { headers: auth }))).body.data[0].id, job.id);
    assert.equal((await fetch(`${app.url}api/jobs/unknown`, { headers: auth })).status, 404);
    // A bad request is refused before any job starts.
    assert.equal((await fetch(`${app.url}api/alerts/check`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ chain: 'nowhere' }) })).status, 400);
  } finally {
    controller.abort();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live tickers are shared between pages and stopped when the last page leaves', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-events-'));
  const app = await start(directory);
  const key = '8453:0xd0b53d9277642d899df5c87a3966a349a798f224:auto';
  const open = async () => {
    const controller = new AbortController();
    const response = await fetch(`${app.url}api/events?tickers=${key}`, { headers: auth, signal: controller.signal });
    const reader = response.body!.getReader();
    let text = '';
    while (!/offline: live prices are off/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    return controller;
  };
  try {
    const first = await open();
    const second = await open();
    assert.deepEqual(app.state.hub.stats, { clients: 2, feeds: 1 });
    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(app.state.hub.stats, { clients: 1, feeds: 1 });
    second.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(app.state.hub.stats, { clients: 0, feeds: 0 });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a taken port moves on to the next one, unless --strict-port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-port-'));
  const first = await start(directory);
  try {
    const second = await start(directory, { port: first.port });
    assert.equal(second.port, first.port + 1);
    await second.close();
    await assert.rejects(start(directory, { port: first.port, strictPort: true }), /Port \d+ is already in use\. Choose another with --port/);
    await assert.rejects(start(directory, { token: 'short' }), /at least 16 characters/);
  } finally {
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dashboard serve starts from the command line, prints its address as JSON, and stops cleanly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-dash-cli-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEFI_TOOL_') && !key.startsWith('RPC_URL_'))), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db') };
  const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'dashboard', 'serve', ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('"loginUrl"')) {
        const { url } = JSON.parse(stdout) as { url: string };
        void fetch(`${url}api/health`, { headers: auth }).then((response) => { stdout += `\nhealth ${response.status}`; child.kill('SIGTERM'); });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const served = await run('--no-open', '--json', '--port', '0', '--offline', '--token', TOKEN, '--data-dir', join(directory, 'dex-data'));
    assert.match(served.stdout, /"url":"http:\/\/127\.0\.0\.1:\d+\/"/);
    assert.match(served.stdout, /health 200/);
    assert.equal(served.code, 0, served.stderr);
    for (const [args, message] of [[['--port', 'abc'], /--port "abc" is not a port number/], [['--refresh', '5s'], /--refresh must be at least 15s/]] as const) {
      const failed = await run('--no-open', ...args);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('helpers: TTL cache shares in-flight loads and never caches failures; router params; hosts; nonces; ticker keys', async () => {
  let now = 0;
  const cache = new TtlCache(10, () => now);
  let loads = 0;
  const load = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return loads; };
  const [a, b] = await Promise.all([cache.get('k', 100, load), cache.get('k', 100, load)]);
  assert.equal(loads, 1);
  assert.equal(a.value, b.value);
  assert.equal((await cache.get('k', 100, load)).cached, true);
  now = 200;
  assert.equal((await cache.get('k', 100, load)).value, 2);
  assert.equal((await cache.get('k', 100, load, { refresh: true })).value, 3);
  await assert.rejects(cache.get('bad', 100, async () => { throw new Error('down'); }));
  assert.equal((await cache.get('bad', 100, async () => 'up')).value, 'up');
  cache.invalidate('k');
  assert.equal(cache.size, 1);

  const router = new Router().get('/api/wallets/:name/history', () => 1).put('/api/wallets/default', () => 2);
  const found = router.match('GET', '/api/wallets/my%20wallet/history');
  assert.ok(found && 'route' in found);
  assert.deepEqual(found.params, { name: 'my wallet' });
  assert.deepEqual(router.match('POST', '/api/wallets/default'), { allowed: ['PUT'] });
  assert.equal(router.match('GET', '/api/other'), undefined);

  assert.ok(allowedHosts('127.0.0.1', 8787).has('localhost:8787'));
  assert.ok(allowedHosts('::1', 9).has('[::1]:9'));
  assert.ok(!allowedHosts('127.0.0.1', 8787).has('evil.example:8787'));
  assert.equal(withNonce('<style>a{}</style><script>1</script><script type="application/json">{}</script>', 'N'), '<style nonce="N">a{}</style><script nonce="N">1</script><script nonce="N" type="application/json">{}</script>');
  assert.deepEqual(parseTickerKey('8453:0xD0B53D9277642d899DF5C87A3966A349A798F224:USDC'), { chainId: 8453, address: '0xd0b53d9277642d899df5c87a3966a349a798f224', quote: 'usdc' });
  assert.throws(() => parseTickerKey('1:../../etc'), /is not a ticker key/);
});

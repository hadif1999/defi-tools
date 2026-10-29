import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from '../src/types.js';

function isolatedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('UNISWAP_') && !name.startsWith('DEFI_TOOL_') && !name.startsWith('RPC_URL_')));
}

function run(args: string[], config = '/nonexistent/defi-tool-test/config.json') {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: config },
  });
}

test('root, groups, and subcommands explain themselves without a config or network', () => {
  for (const path of [[], ['help'], ['pools'], ['positions'], ['alerts'], ['init'], ['chains'], ['pools', 'scan'], ['pools', 'get'], ['pools', 'rank'], ['positions', 'analyze'], ['positions', 'list'], ['positions', 'create'], ['alerts', 'check'], ['wallet'], ['wallet', 'add'], ['wallet', 'list'], ['wallet', 'edit'], ['wallet', 'delete']]) {
    const result = run([...path, '--help']);
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.match(result.stdout, /defi-tool\b/);
    assert.match(result.stdout, /Examples:/);
    assert.match(result.stdout, /defi-tool (help|init|chains|pools|positions|alerts|wallet)/);
  }
  for (const path of [[], ['pools'], ['positions'], ['alerts'], ['wallet']]) {
    const result = run(path);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stderr, /error:/i);
  }
});

test('help command resolves nested commands and aliases', () => {
  for (const path of [['pools', 'rank'], ['positions', 'list'], ['alerts', 'check']]) {
    const result = run(['help', ...path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--chain/);
    assert.match(result.stdout, /Examples:/);
  }
  const missing = run(['help', 'positions', 'misspelled']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /unknown command/i);
});

test('chains command lists friendly names, BNB Chain and Robinhood Chain', () => {
  const result = run(['chains']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ethereum/);
  assert.match(result.stdout, /arb/);
  assert.match(result.stdout, /RPC_URL_ETH/);
  assert.match(result.stdout, /BNB Chain/);
  assert.match(result.stdout, /Robinhood Chain/);
  assert.match(result.stdout, /RPC_URL_ROBINHOOD/);
  assert.match(result.stdout, /Robinhood.*--source geckoterminal/);
  assert.match(result.stdout, /Solana.*Raydium/);
  assert.doesNotMatch(result.stdout, /RPC_URL_SOLANA/);
});

test('Solana is for Raydium pool listings: other sources and position reads say so', () => {
  const gecko = run(['pools', 'scan', '--chain', 'solana', '--source', 'geckoterminal']);
  assert.equal(gecko.status, 1);
  assert.match(gecko.stderr, /geckoterminal source lists Uniswap pools only\. Drop --source to list Raydium pools/);
  const uniswapOnly = run(['pools', 'scan', '--chain', 'solana', '--protocol', 'v3,v4,v2', '--source', 'geckoterminal']);
  assert.match(uniswapOnly.stderr, /Note: no Solana pools, because Raydium pools are clmm or amm and --protocol is v2,v3,v4\. Add clmm,amm/);
  const otherDex = run(['pools', 'scan', '--chain', 'solana', '--dex', 'curve', '--source', 'geckoterminal']);
  assert.equal(otherDex.status, 1);
  assert.match(otherDex.stderr, /geckoterminal source lists Uniswap pools only\. Drop --source to list curve pools from DefiLlama/);
  const badDex = run(['pools', 'get', 'ETH/USDC', '--dex', 'sushiswap']);
  assert.equal(badDex.status, 1);
  assert.match(badDex.stderr, /--dex "sushiswap" is not supported\. Use uniswap, pancakeswap, aerodrome, curve, raydium/);
  const positions = run(['positions', 'analyze', '--chain', 'sol', '--wallet', `0x${'1'.repeat(40)}`]);
  assert.equal(positions.status, 1);
  assert.match(positions.stderr, /Positions are read for Uniswap on EVM chains only, not Solana/);
});

test('init validates options before writing and protects existing settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-cli-'));
  const config = join(directory, 'config.json');
  try {
    const bad = run(['init', '--chain', 'fantom'], config);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not supported/i);
    const good = run(['init', '--chain', 'eth,base', '--wallet', '0x0000000000000000000000000000000000000001'], config);
    assert.equal(good.status, 0, good.stderr);
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    assert.deepEqual(saved.chains, [1, 8453]);
    assert.equal(saved.wallets.length, 1);
    const original = readFileSync(config, 'utf8');
    assert.equal(run(['init'], config).status, 1);
    assert.equal(readFileSync(config, 'utf8'), original);
    assert.equal(run(['init', '--force', '--chain', 'arb'], config).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).chains, [42161]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid wallet and chain inputs fail before contacting providers', () => {
  for (const args of [['positions', 'list', '--wallet', 'not-a-wallet'], ['alerts', 'check', '--wallet', 'not-a-wallet'], ['pools', 'rank', '--chain', 'fantom']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /(wallet.*0x|not supported|no saved wallet named)/i);
    assert.doesNotMatch(result.stderr, /fetch failed/);
  }
});

test('friendly pool flags reach the API as IDs and results display network names', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-pools-'));
  const requests: Array<{ chainId: number; limit: number }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const variables = JSON.parse(body).variables;
      requests.push(variables);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { pools: [{ id: 'pool-a', protocol: 'v3', token0: { id: 'a', symbol: 'A', decimals: 18 }, token1: { id: 'b', symbol: 'B', decimals: 18 }, tvlUsd: 1000, fees24hUsd: 2, volume24hUsd: 100 }] } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'rank', '--chain', 'eth,1,arb', '--top', '2', '--api-url', `http://127.0.0.1:${address.port}`], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db') },
    });
    assert.deepEqual(requests.sort((a, b) => a.chainId - b.chainId), [{ chainId: 1, limit: 2 }, { chainId: 42161, limit: 2 }]);
    assert.match(result.stdout, /Ethereum/);
    assert.match(result.stdout, /Arbitrum/);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GeckoTerminal pool CLI uses GET without forwarding a stored key and supports JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-public-'));
  const requests: string[] = [];
  let leakedKey = false;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    leakedKey ||= request.headers['x-api-key'] !== undefined;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'eth_pool', attributes: {
      address: '0x0000000000000000000000000000000000000001', reserve_in_usd: '5000', volume_usd: { h24: '3000' },
    }, relationships: {
      base_token: { data: { id: 'eth_0x0000000000000000000000000000000000000002' } },
      quote_token: { data: { id: 'eth_0x0000000000000000000000000000000000000003' } },
    } }] }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'rank', '--source', 'geckoterminal', '--api-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--chain', 'eth', '--top', '1', '--json'], {
      timeout: 10_000, encoding: 'utf8', env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), UNISWAP_API_KEY: 'test-only-do-not-forward', DEFI_TOOL_DB_PATH: join(directory, 'state.db'), DEFI_TOOL_DEXSCREENER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
    });
    assert.equal(leakedKey, false);
    assert.match(requests[0]!, /^GET \/networks\/eth\/dexes\/uniswap_v3\/pools/);
    assert.ok(requests.every((line) => line.startsWith('GET ')), 'no request leaves the test server');
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 1);
    assert.equal(output.data[0].pool.source, 'geckoterminal');
    assert.equal(output.data[0].pool.chainId, 1);
    assert.equal(output.data[0].pool.tvlUsd, 5000);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-do-not-forward/);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v4 explains explicit-ID requirements before making a network request', () => {
  const result = run(['positions', 'analyze', '--protocol', 'v4', '--wallet', '0x0000000000000000000000000000000000000001', '--chain', 'eth']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--position/);
  assert.doesNotMatch(result.stderr, /fetch failed/);
  const ambiguous = run(['positions', 'analyze', '--wallet', '0x0000000000000000000000000000000000000001', '--position', '42', '--chain', 'eth,base']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /one --chain/);
});

test('pools scan lists pools like the Explore page, with filters applied before --top', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-scan-'));
  let requests = 0;
  const row = (pool: string, chain: string, project: string, symbol: string, tvlUsd: number, poolMeta: string | null) => ({
    pool, chain, project, symbol, tvlUsd, poolMeta, apyBase: 30.39, volumeUsd1d: 29_900_000, volumeUsd7d: 210_000_000, underlyingTokens: [],
  });
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.url, '/pools');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'success', data: [
      row('wise', 'Ethereum', 'uniswap-v2', 'WISE-WETH', 134_200_000, null),
      row('usdt', 'Ethereum', 'uniswap-v3', 'WETH-USDT', 89_700_000, '0.3%'),
      row('pyusd', 'Ethereum', 'uniswap-v4', 'PYUSD-USDS', 100_100_000, '0.00%'),
      row('base', 'Base', 'uniswap-v3', 'WETH-USDC', 5_000_000, '0.05%'),
    ] }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const exec = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'scan', '--source', 'public', '--api-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`, ...args], {
    timeout: 10_000, encoding: 'utf8', env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db') },
  });
  try {
    const table = (await exec(['--chain', 'eth', '--top', '2'])).stdout;
    assert.match(table, /#\s+Pool\s+Chain\s+DEX\s+Version\s+Fee\s+TVL\s+1D vol\s+7D vol\s+1D vol\/TVL\s+APR/);
    assert.match(table, /1\s+WISE\/WETH\s+Ethereum\s+Uniswap\s+v2\s+0\.3%\s+\$134\.2M\s+\$29\.9M\s+\$210\.0M\s+0\.22\s+30\.39%/);
    assert.match(table, /2\s+PYUSD\/USDS\s+Ethereum\s+Uniswap\s+v4\s+<0\.01%\s+\$100\.1M/);
    assert.doesNotMatch(table, /WETH\/USDT|'WISE/); // No console.table quoting.

    // Robinhood Chain is not on DefiLlama; the error says which source has it.
    await assert.rejects(exec(['--chain', 'robinhood']), (error: { stderr: string }) => /DefiLlama has no Uniswap pools on Robinhood Chain\. Add --source geckoterminal/.test(error.stderr));

    // --top cuts the merged list: two rows in total across both chains, not two per chain.
    const merged = (await exec(['--chain', 'ETH,Base', '--top', '2', '--sort', 'TVL,Apr', '--protocol', 'ALL', '--source', 'PUBLIC'])).stdout;
    assert.match(merged, /sorted by TVL, then APR/);
    assert.equal(merged.match(/^\s*\d+\s{2}/gm)?.length, 2);
    assert.match(merged, /1\s+WISE\/WETH\s+Ethereum/);
    assert.doesNotMatch(merged, /Base\s+Uniswap\s+v3/);

    const ranked = (await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'rank', '--source', 'public', '--api-url', `http://127.0.0.1:${(server.address() as { port: number }).port}`, '--chain', 'eth,base', '--top', '3', '--json'], {
      timeout: 10_000, encoding: 'utf8', env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db') },
    })).stdout;
    const scores = JSON.parse(ranked).data.map((item: { score: number }) => item.score);
    assert.equal(scores.length, 3);
    assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));

    const conditions = (await exec(['--chain', 'eth,base', '--filter', 'tvl<100m', '--filter', 'col.APR>10, vol/tvl>0.3'])).stdout;
    assert.match(conditions, /Filters: TVL < \$100m and APR > 10% and 1D vol\/TVL > 0.3/);
    assert.match(conditions, /WETH\/USDT/);
    assert.match(conditions, /WETH\/USDC/);
    assert.doesNotMatch(conditions, /WISE|PYUSD/);
    await assert.rejects(exec(['--filter', 'apr>>1']), (error: { stderr: string }) => /--filter value ">1" is not a number/.test(error.stderr));

    const filtered = (await exec(['--chain', 'eth,base', '--token', 'USDT', '--top', '1'])).stdout;
    assert.match(filtered, /WETH\/USDT\s+Ethereum\s+Uniswap\s+v3/);
    assert.doesNotMatch(filtered, /WISE|PYUSD|Base\s+Uniswap\s+v3/);

    const versions = (await exec(['--chain', 'base,eth', '--top', '50', '--protocol', 'v3,V2', '--sort', 'tvl,apr'])).stdout;
    assert.match(versions, /WISE\/WETH\s+Ethereum\s+Uniswap\s+v2/);
    assert.match(versions, /WETH\/USDC\s+Base\s+Uniswap\s+v3/);
    assert.doesNotMatch(versions, /PYUSD|\bv4\b/);
    const json = JSON.parse((await exec(['--chain', 'eth', '--protocol', 'v3', '--json'])).stdout);
    assert.equal(json.schemaVersion, 1);
    assert.deepEqual(json.data.map((item: { pool: { id: string } }) => item.pool.id), ['usdt']);
    assert.equal(json.data[0].pool.feeTier, 3000);
    for (const [args, message] of [[['--sort', 'tvl,fees'], /--sort "fees" is not a sort key/], [['--protocol', 'v5'], /--protocol "v5" is not supported/]] as const) {
      await assert.rejects(exec([...args]), (error: { code: number; stderr: string }) => error.code === 1 && message.test(error.stderr));
    }
    assert.equal(typeof json.data[0].score, 'number');
    assert.equal(requests, 7); // One download per run, shared by both chains.
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pools scan adds age and 1D txns, caches pool identities and age, and survives a DexScreener outage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-details-'));
  let dexscreenerUp = true;
  const dexscreener: string[] = [];
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pools') return response.end(JSON.stringify({ data: [{
      pool: 'uuid-v3', chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', tvlUsd: 81_900_000, apyBase: 8.88, volumeUsd1d: 39_800_000, volumeUsd7d: 233_800_000, poolMeta: '0.05%',
      underlyingTokens: [USDC, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
    }, {
      pool: 'uuid-v4', chain: 'Ethereum', project: 'uniswap-v4', symbol: 'ETH-USDC', tvlUsd: 41_500_000, apyBase: 1.52, volumeUsd1d: 493_200, volumeUsd7d: 12_700_000, poolMeta: '0.35%',
      underlyingTokens: ['0x0000000000000000000000000000000000000000', USDC],
    }] }));
    dexscreener.push(request.url!);
    if (!dexscreenerUp) { response.statusCode = 503; return response.end('{}'); }
    if (request.url!.startsWith('/token-pairs/')) return response.end(JSON.stringify([{
      pairAddress: '0x' + 'ab'.repeat(32), dexId: 'uniswap', labels: ['v4'], liquidity: { usd: 41_400_000 }, pairCreatedAt: Date.parse('2025-01-30T00:00:00Z'),
      baseToken: { address: '0x0000000000000000000000000000000000000000' }, quoteToken: { address: USDC }, txns: { h24: { buys: 100, sells: 86 } },
    }]));
    const pairs = [{ pairAddress: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', pairCreatedAt: Date.parse('2021-05-05T21:42:11Z'), txns: { h24: { buys: 2360, sells: 2093 } } },
      { pairAddress: '0x' + 'ab'.repeat(32), pairCreatedAt: Date.parse('2025-01-30T00:00:00Z'), txns: { h24: { buys: 100, sells: 86 } } }];
    response.end(JSON.stringify({ pairs: pairs.filter((pair) => request.url!.toLowerCase().includes(pair.pairAddress.toLowerCase())) }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exec = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'scan', '--source', 'public', '--api-url', url, '--chain', 'eth', ...args], {
    timeout: 20_000, encoding: 'utf8', env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db'), DEFI_TOOL_DEXSCREENER_URL: url },
  });
  try {
    const table = await exec([]);
    assert.match(table.stdout, /APR\s+1D txns\s+Age/);
    assert.match(table.stdout, /8\.88%\s+4\.5K\s+\d\.\dy/);
    assert.match(table.stdout, /1\.52%\s+186\s+\d+(\.\d)?(y|mo)/);
    assert.equal(dexscreener.filter((path) => path.startsWith('/token-pairs/')).length, 1);

    // Second run: the v4 match comes from the cache, so only the batch lookup (for 1D txns) is made.
    dexscreener.length = 0;
    const json = JSON.parse((await exec(['--json'])).stdout).data.map((item: { pool: Pool }) => item.pool);
    assert.deepEqual(dexscreener, [`/latest/dex/pairs/ethereum/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,0x${'ab'.repeat(32)}`]);
    assert.equal(json[0].address, '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
    assert.equal(json[0].createdAt, '2021-05-05T21:42:11.000Z');
    assert.equal(json[0].txCount24h, 4453);
    assert.equal(json[1].address, `0x${'ab'.repeat(32)}`);
    assert.equal(json[1].txCount24h, 186);

    // Age filters: the v3 pool is from 2021, the v4 pool from 2025-01-30.
    const old = (await exec(['--filter', 'Age>3y'])).stdout;
    assert.match(old, /Filters: Age > 3y/);
    assert.match(old, /USDC\/WETH/);
    assert.doesNotMatch(old, /ETH\/USDC/);
    const young = (await exec(['--filter', 'age<3y', '--filter', 'apr>1'])).stdout;
    assert.match(young, /ETH\/USDC/);
    assert.doesNotMatch(young, /USDC\/WETH/);

    // DexScreener down: ages still come from the cache; only the live 1D txns are missing.
    dexscreenerUp = false;
    const degraded = await exec([]);
    assert.match(degraded.stdout, /8\.88%\s+—\s+\d\.\dy/);
    assert.match(degraded.stdout, /1\.52%\s+—\s+\d+(\.\d)?(y|mo)/);
    assert.match(degraded.stderr, /pool ages and 1D txns are unavailable: DexScreener .* HTTP 503/);
    // With DexScreener down, the age filter still works from cached ages, and says so.
    const cachedOnly = await exec(['--filter', 'age>3y']);
    assert.match(cachedOnly.stdout, /USDC\/WETH/);
    assert.match(cachedOnly.stderr, /age filter used cached ages only/);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pools get lists one pair on every network and DEX, in either token order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-get-'));
  const row = (pool: string, chain: string, project: string, symbol: string, tvlUsd: number, poolMeta: string | null, apyBase = 40) => ({
    pool, chain, project, symbol, tvlUsd, poolMeta, apyBase, volumeUsd1d: tvlUsd / 2, volumeUsd7d: tvlUsd * 3, underlyingTokens: [],
  });
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pools') return response.end(JSON.stringify({ data: [
      row('clmm', 'Solana', 'raydium-amm', 'WSOL-USDC', 9_000_000, 'Concentrated - 0.04%'),
      row('amm', 'Solana', 'raydium-amm', 'USDC-SOL', 4_000_000, 'Standard - 0.25%', 20),
      row('usdt', 'Solana', 'raydium-amm', 'WSOL-USDT', 8_000_000, 'Concentrated - 0.01%'),
      row('ray', 'Solana', 'raydium-amm', 'RAY-USDC', 7_000_000, 'Standard - 0.25%'),
      row('eth', 'Ethereum', 'uniswap-v3', 'USDC-WETH', 80_000_000, '0.05%'),
      row('base', 'Base', 'uniswap-v4', 'ETH-USDC', 6_000_000, '0.05%'),
      row('3pool', 'Ethereum', 'curve-dex', 'DAI-USDC-USDT', 160_000_000, null),
      row('cake', 'BSC', 'pancakeswap-amm', 'USDT-USDC', 2_000_000, null),
      row('aero', 'Base', 'aerodrome-slipstream', 'WETH-USDC', 4_000_000, 'CL100 - 0.05%'),
    ] }));
    // No DexScreener matches: age and 1D txns stay empty.
    response.end(request.url!.startsWith('/token-pairs/') ? '[]' : '{"pairs":[]}');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const exec = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'pools', 'get', ...args, '--api-url', url, '--source', 'public'], {
    timeout: 20_000, encoding: 'utf8', env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db'), DEFI_TOOL_DEXSCREENER_URL: url },
  });
  try {
    // No --chain: every network, without an error for Robinhood Chain (not on DefiLlama).
    const solana = await exec(['WSOL/USDC']);
    assert.match(solana.stdout, /Pair: WSOL\/USDC \(either token order\)/);
    assert.match(solana.stdout, /1\s+WSOL\/USDC\s+Solana\s+Raydium\s+CLMM/);
    assert.match(solana.stdout, /2\s+USDC\/SOL\s+Solana\s+Raydium\s+AMM/);
    assert.equal(solana.stdout.match(/^\s*\d+\s{2}/gm)?.length, 2);
    assert.doesNotMatch(solana.stdout, /USDT|RAY/);
    assert.doesNotMatch(solana.stderr, /Robinhood/);

    const eth = (await exec(['usdc/eth', '--chain', 'all'])).stdout;
    assert.match(eth, /1\s+USDC\/WETH\s+Ethereum\s+Uniswap\s+v3/);
    assert.match(eth, /2\s+ETH\/USDC\s+Base\s+Uniswap\s+v4/);
    assert.match(eth, /3\s+WETH\/USDC\s+Base\s+Aerodrome\s+CLMM\s+0\.05%/);
    assert.equal(eth.match(/^\s*\d+\s{2}/gm)?.length, 3);

    // Other DEXes: Curve's three-token pool matches any two of its tokens; --dex narrows the exchanges.
    const stables = (await exec(['USDT/USDC'])).stdout;
    assert.match(stables, /1\s+DAI\/USDC\/USDT\s+Ethereum\s+Curve\s+AMM/);
    assert.match(stables, /2\s+USDT\/USDC\s+BNB Chain\s+PancakeSwap\s+v2\s+0\.25%/);
    const curve = (await exec(['USDT/USDC', '--dex', 'Curve'])).stdout;
    assert.match(curve, /Curve/);
    assert.doesNotMatch(curve, /PancakeSwap/);
    assert.doesNotMatch((await exec(['DAI/DAI'])).stdout, /Curve/); // A pair needs two different tokens of the pool.

    // Scan options apply: protocol, filters, sort, top.
    const filtered = (await exec(['WSOL/USDC', '--chain', 'sol,eth', '--protocol', 'v3,v4,clmm,amm', '--sort', 'APR,TVL', '--filter', 'APR>30', '--filter', 'TVL>1M', '--top', '5'])).stdout;
    assert.match(filtered, /Filters: APR > 30% and TVL > \$1M/);
    assert.match(filtered, /WSOL\/USDC\s+Solana\s+Raydium\s+CLMM/);
    assert.doesNotMatch(filtered, /USDC\/SOL/);

    const json = JSON.parse((await exec(['SOL/USDC', '--protocol', 'amm', '--json'])).stdout);
    assert.deepEqual(json.data.map((item: { pool: Pool }) => item.pool.id), ['amm']);

    await assert.rejects(exec(['WSOL']), (error: { code: number; stderr: string }) => error.code === 1 && /Pair "WSOL" needs two tokens joined by \//.test(error.stderr));
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wallet commands validate input and keep wallets in the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-wallet-'));
  const wallet = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'wallet', ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...isolatedEnv(), DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db') },
  });
  const evm = `0x${'Ab'.repeat(20)}`;
  try {
    assert.match(wallet('list').stdout, /No saved wallets/);
    const added = wallet('add', evm, '--chain', 'ETH');
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, new RegExp(`Saved wallet0: ${evm.toLowerCase()} on Ethereum`));
    assert.equal(wallet('add', 'So11111111111111111111111111111111111111112', '--chain', 'sol', '--name', 'phantom').status, 0);
    for (const [args, message] of [
      [['add', evm], /required option '--chain/],
      [['add', evm, '--chain', 'all'], /--chain takes one network/],
      [['add', evm, '--chain', 'sol'], /not a valid Solana address.*looks like an EVM address/],
      [['add', 'So11111111111111111111111111111111111111112', '--chain', 'base'], /not a valid Base address.*use --chain sol/],
      [['add', evm, '--chain', 'eth', '--name', 'other'], /already saved for that network as "wallet0"/],
      [['add', evm, '--chain', 'base', '--name', 'bad name!'], /Wallet name "bad name!" is not valid/],
      [['edit', 'wallet0'], /Nothing to change/],
      [['edit', 'phantom', '--chain', 'eth'], /not a valid Ethereum address/],
      [['delete', 'missing'], /No saved wallet named "missing"/],
    ] as const) {
      const result = wallet(...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, message);
    }
    const edited = wallet('edit', 'WALLET0', '--name', 'my-wallet1', '--chain', 'base');
    assert.equal(edited.status, 0, edited.stderr);
    assert.match(edited.stdout, /Updated wallet0: now my-wallet1, 0xabab.* on Base/);
    const table = wallet('list').stdout;
    assert.match(table, /Name\s+Chain\s+Type\s+Address\s+Added \(UTC\)\s+Updated \(UTC\)\s+Positions\s+Last checked \(UTC\)/);
    assert.match(table, /my-wallet1\s+Base\s+EVM\s+0xabab/);
    assert.match(table, /phantom\s+Solana\s+Solana\s+So111/);
    assert.match(wallet('rm', 'phantom').stdout, /Deleted phantom/);
    assert.deepEqual(JSON.parse(wallet('list', '--json').stdout).data.map((item: { name: string }) => item.name), ['my-wallet1']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

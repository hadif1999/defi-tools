import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from 'viem';
import { RpcProvider } from '../src/providers/rpc.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const wallet = '0x0000000000000000000000000000000000000001';
const pool = '0x0000000000000000000000000000000000000002';
const token0 = '0x0000000000000000000000000000000000000003';
const token1 = '0x0000000000000000000000000000000000000004';

async function withRpc(scenario: 'v3' | 'v4' | 'wrong-owner' | 'too-many' | 'alert', action: (rpc: RpcProvider, url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const request = JSON.parse(text);
      if (request.method === 'eth_getBalance') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x6f05b59d3b20000' })); return; } // 0.5 ETH.
      const data: string = request.params[0].data;
      let result: `0x${string}`;
      if (data.startsWith(toFunctionSelector('balanceOf(address)'))) result = encodeAbiParameters(parseAbiParameters('uint256'), [scenario === 'too-many' ? 501n : 1n]);
      else if (data.startsWith(toFunctionSelector('tokenOfOwnerByIndex(address,uint256)'))) result = encodeAbiParameters(parseAbiParameters('uint256'), [42n]);
      else if (data.startsWith(toFunctionSelector('ownerOf(uint256)'))) result = encodeAbiParameters(parseAbiParameters('address'), [scenario === 'wrong-owner' ? pool : wallet]);
      else if (data.startsWith(toFunctionSelector('factory()'))) result = encodeAbiParameters(parseAbiParameters('address'), [pool]);
      else if (data.startsWith(toFunctionSelector('getPool(address,address,uint24)'))) result = encodeAbiParameters(parseAbiParameters('address'), [pool]);
      else if (data.startsWith(toFunctionSelector('positions(uint256)'))) result = encodeAbiParameters(parseAbiParameters('uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128'), [0n, wallet, token0, token1, 3000, -100, 200, 10n, 0n, 0n, 0n, 0n]);
      else if (data.startsWith(toFunctionSelector('slot0()'))) result = encodeAbiParameters(parseAbiParameters('uint160,int24,uint16,uint16,uint16,uint8,bool'), [1n, scenario === 'alert' ? 250 : 150, 0, 0, 0, 0, true]);
      else if (data.startsWith(toFunctionSelector('getPoolAndPositionInfo(uint256)'))) {
        const packed = ((BigInt(-100) & 0xffffffn) << 8n) | (200n << 32n);
        result = encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address),uint256'), [[token0, token1, 3000, 60, wallet], packed]);
      } else if (data.startsWith(toFunctionSelector('getPositionLiquidity(uint256)'))) result = encodeAbiParameters(parseAbiParameters('uint128'), [10n]);
      else if (data.startsWith(toFunctionSelector('symbol()'))) result = encodeAbiParameters(parseAbiParameters('string'), [request.params[0].to.toLowerCase() === token0 ? 'AAA' : 'BBB']);
      else if (data.startsWith(toFunctionSelector('decimals()'))) result = encodeAbiParameters(parseAbiParameters('uint8'), [18]);
      else if (data.startsWith(toFunctionSelector('collect((uint256,address,uint128,uint128))'))) result = encodeAbiParameters(parseAbiParameters('uint256,uint256'), [5n * 10n ** 17n, 0n]);
      else if (data.startsWith(toFunctionSelector('getSlot0(bytes32)'))) result = encodeAbiParameters(parseAbiParameters('uint160,int24,uint24,uint24'), [1n, -90, 0, 3000]);
      else { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } })); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await action(new RpcProvider({ 1: url }), url);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
}

test('discovers v3 wallet positions and live ticks over unauthenticated RPC', async () => {
  await withRpc('v3', async (rpc) => {
    const [position] = await rpc.listPositions(wallet, 1, 'v3');
    assert.equal(position?.id, '42');
    assert.equal(position?.lowerTick, -100);
    assert.equal(position?.upperTick, 200);
    assert.equal(position?.currentTick, 150);
    assert.equal(position?.source, 'rpc');
    assert.equal(position?.poolId, pool);
    assert.equal(position?.valueUsd, undefined);
  });
});

test('positions and alerts CLI default to key-free RPC, including alert exit codes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uniswap-rpc-cli-'));
  try {
    await withRpc('alert', async (_rpc, url) => {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ wallets: [wallet], chains: [1], rpcUrls: { 1: url }, databasePath: join(directory, 'state.db') }));
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNISWAP_') && !key.startsWith('DEFI_TOOL_') && !key.startsWith('RPC_URL_'))), DEFI_TOOL_CONFIG: config };
      const execute = promisify(execFile);
      const position = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'positions', 'analyze', '--json'], { env, timeout: 10_000 });
      assert.equal(JSON.parse(position.stdout).data[0].status, 'out_of_range_above');
      assert.equal(JSON.parse(position.stdout).data[0].source, 'rpc');
      try {
        await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'alerts', 'check', '--json'], { env, timeout: 10_000 });
        assert.fail('First check must exit 2 for an actionable alert');
      } catch (error) {
        const result = error as Error & { code: number; stdout: string };
        assert.equal(result.code, 2);
        assert.equal(JSON.parse(result.stdout).data[0].type, 'out_of_range');
      }
      const repeated = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'alerts', 'check', '--json'], { env, timeout: 10_000 });
      assert.deepEqual(JSON.parse(repeated.stdout).data, []);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('positions analyze checks saved wallets on their own and saved networks, by name, by default or all, and wallet list shows balances', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-wallets-'));
  try {
    await withRpc('v3', async (_rpc, url) => {
      const config = join(directory, 'config.json');
      // No init wallets: only saved wallets are checked, on their own network and the saved networks (Base, whose RPC is down).
      // Solana RPC and DefiLlama prices are unreachable: wallet list still shows the ETH read from the fixture node.
      writeFileSync(config, JSON.stringify({ chains: [8453], rpcUrls: { 1: url, 8453: 'http://127.0.0.1:9', 501: 'http://127.0.0.1:9' }, databasePath: join(directory, 'state.db') }));
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNISWAP_') && !key.startsWith('DEFI_TOOL_') && !key.startsWith('RPC_URL_'))), DEFI_TOOL_CONFIG: config, DEFI_TOOL_PRICES_URL: 'http://127.0.0.1:9' };
      const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env, timeout: 10_000 });
      await cli('wallet', 'add', wallet, '--chain', 'eth', '--name', 'main');
      await cli('wallet', 'add', 'So11111111111111111111111111111111111111112', '--chain', 'sol');
      const named = await cli('positions', 'analyze', '--wallet', 'MAIN', '--json');
      assert.deepEqual(JSON.parse(named.stdout).data.map((item: { chainId: number; wallet: string }) => [item.chainId, item.wallet]), [[1, wallet]]);
      assert.match(named.stderr, /on Base:/);
      // Without --wallet: the default wallet, here the latest added (Solana), which has no Uniswap positions.
      await assert.rejects(cli('positions', 'analyze', '--json'), /EVM chains only, not Solana/);
      await cli('wallet', 'set-default', 'main');
      const byDefault = await cli('positions', 'analyze');
      assert.match(byDefault.stderr, /Using the default wallet main/);
      // --wallet all: every saved wallet; the Solana one is skipped with a note.
      const all = await cli('positions', 'analyze', '--wallet', 'all', '--json');
      assert.equal(JSON.parse(all.stdout).data.length, 1);
      assert.match(all.stderr, /skipping Solana/);
      const listed = JSON.parse((await cli('wallet', 'list', '--json')).stdout).data;
      assert.deepEqual(listed.map((item: { name: string }) => item.name), ['main', 'wallet0']);
      assert.deepEqual(listed[0].balance.holdings, [{ symbol: 'ETH', amount: 0.5 }]); // No price, so no USD value.
      assert.match(listed[1].balanceError, /Solana RPC|fetch failed|ECONNREFUSED/);
      const table = await cli('wallet', 'list');
      assert.match(table.stdout, /#\s+Name\s+Default\s+Chain\s+Type\s+Address\s+Balance\s+Holdings\s+Added \(UTC\)/);
      assert.match(table.stdout, /main\s+★ default\s+Ethereum\s+EVM\s+0x0+1\s+—\s+0\.5000 ETH/);
      assert.match(table.stdout, /wallet0\s+Solana\s+Solana\s+So1+\w*\s+—\s+unavailable/);
      assert.match(table.stderr, /Balances unavailable: wallet0/);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('positions list falls back to on-chain reads when Revert Finance is unreachable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-fallback-'));
  try {
    await withRpc('v3', async (_rpc, url) => {
      const config = join(directory, 'config.json');
      writeFileSync(config, JSON.stringify({ rpcUrls: { 1: url }, databasePath: join(directory, 'state.db') }));
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNISWAP_') && !key.startsWith('DEFI_TOOL_') && !key.startsWith('RPC_URL_'))),
        DEFI_TOOL_CONFIG: config, DEFI_TOOL_REVERT_URL: 'http://127.0.0.1:9', DEFI_TOOL_PRICES_URL: 'http://127.0.0.1:9' };
      const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'positions', 'list', '--wallet-addr', wallet, '--chain', 'eth', ...args], { env, timeout: 15_000 });
      const json = await cli('--json');
      assert.match(json.stderr, /Could not reach Revert Finance.*Showing on-chain data instead/);
      assert.match(json.stderr, /USD values are unavailable/);
      const [position] = JSON.parse(json.stdout).data.active;
      assert.equal(position.id, '42');
      assert.equal(position.source, 'rpc');
      assert.equal(position.historyAvailable, false);
      assert.deepEqual([position.token0.symbol, position.token1.symbol], ['AAA', 'BBB']);
      assert.equal(position.uncollectedFees0, 0.5); // Simulated collect() result, decimals applied.
      assert.equal(position.depositedUsd, undefined);
      // The table leaves out history columns that no row has, and says why.
      const table = await cli('--source', 'rpc');
      assert.match(table.stdout, /Source: on-chain RPC and DefiLlama prices/);
      assert.match(table.stdout, /#\s+Pool\s+ID\s+Price\s+Range \(min – max\)\s+Unit\s+Status\s+Balance\s+Age|#\s+Pool\s+ID\s+Price\s+Range \(min – max\)\s+Unit\s+Status\s+Balance\n/);
      assert.match(table.stdout, /AAA\/BBB 0\.3% v3\s+#42/);
      assert.doesNotMatch(table.stdout, /Deposited|Fee APR/);
      assert.match(table.stdout, /On-chain data only/);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reads an explicit v4 position ID, signed packed ticks, and singleton state', async () => {
  await withRpc('v4', async (rpc) => {
    const [position] = await rpc.listPositions(wallet, 1, 'v4', ['42']);
    assert.equal(position?.lowerTick, -100);
    assert.equal(position?.upperTick, 200);
    assert.equal(position?.currentTick, -90);
    assert.match(position!.poolId, /^0x[0-9a-f]{64}$/);
  });
});

test('does not silently omit v4 discovery, wrong ownership, or large portfolios', async () => {
  await assert.rejects(new RpcProvider({}).listPositions(wallet, 1, 'v4'), /--position/);
  await withRpc('wrong-owner', async (rpc) => {
    await assert.rejects(rpc.listPositions(wallet, 1, 'v4', ['42']), /not owned/);
  });
  await withRpc('too-many', async (rpc) => {
    await assert.rejects(rpc.listPositions(wallet, 1, 'v3'), /--position/);
  });
});

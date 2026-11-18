import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closedArbitrum, closedEthereum, openBase, WALLET } from './fixtures/revert.js';

const env = (directory: string, extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNISWAP_') && !key.startsWith('DEFI_TOOL_') && !key.startsWith('RPC_URL_'))),
  DEFI_TOOL_CONFIG: join(directory, 'missing.json'), DEFI_TOOL_DB_PATH: join(directory, 'state.db'), ...extra,
});

test('positions list shows open and closed positions as two tables, by saved wallet, the default wallet, address, or all saved wallets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-positions-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('content-type', 'application/json');
    const rows = request.url!.startsWith(`/v1/positions/uniswapv3/account/${WALLET}`) ? [closedArbitrum, openBase, closedEthereum] : [];
    response.end(JSON.stringify({ success: true, data: rows, pagination: { next_cursor: null } }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const variables = env(directory, { DEFI_TOOL_REVERT_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: variables, timeout: 15_000, encoding: 'utf8' });
  const sync = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: variables, timeout: 15_000, encoding: 'utf8' });
  try {
    // An address is read on every network: one open (Base) and two closed positions.
    const all = await cli('positions', 'list', '--wallet-addr', WALLET.toUpperCase().replace('0X', '0x'));
    assert.match(all.stdout, /Uniswap positions · 0x902e…3f00 on all networks/);
    assert.match(all.stdout, /Source: Revert Finance \(no API key\)/);
    assert.match(all.stdout, /Open: 1 \(value \$49\.00, unclaimed fees \$0\.54\) · Closed: 2 · Lifetime fees \$7\.13 · PnL -\$0\.70/);
    assert.match(all.stdout, /Open positions \(1\) · largest value first\n#\s+Pool\s+ID\s+Price\s+Range \(min – max\)\s+Unit\s+Status\s+Balance\s+Value\s+Unclaimed\s+Fees earned\s+Fee APR\s+PnL\s+Age/);
    assert.match(all.stdout, /1\s+WETH\/USDC 0\.3% v3\s+#999\s+2,400\.00\s+2,300\.00 – 2,500\.00\s+USDC per WETH\s+● In range\s+0\.01000 WETH \+ 25\.0000 USDC\s+\$49\.00\s+\$0\.54\s+\$1\.54\s+\d+\.\d\d%\s+\+\$1\.44 \(\+2\.9%\)\s+\d+d/);
    assert.match(all.stdout, /Closed positions \(2\) · most recently closed first\n#\s+Chain\s+Pool\s+ID\s+Range \(min – max\)\s+Exit price\s+Price now\s+Unit\s+Deposited\s+Withdrawn\s+Fees earned\s+Gas\s+Fee APR\s+PnL\s+IL\s+Opened\s+Closed\s+Held/);
    assert.match(all.stdout, /1\s+Arbitrum\s+WETH\/USDC 0\.05% v3\s+#5723933\s+2,354\.34 – 2,570\.90\s+2,305\.85\s+2,312\.12\s+USDC per WETH\s+\$78\.36\s+\$74\.54\s+\$2\.79\s+\$0\.04\s+63\.\d+%\s+-\$1\.07 \(-1\.4%\)\s+-\$1\.28\s+2026-10-08\s+2026-10-29\s+20d/);
    assert.match(all.stdout, /2\s+Ethereum\s+WETH\/USDC 0\.05% v3\s+#1373723/);
    assert.doesNotMatch(all.stdout, /— means/); // Every value is known.

    // --active, --past and --top apply per table.
    const past = (await cli('positions', 'list', '--wallet-addr', WALLET, '--past', '--top', '1')).stdout;
    assert.doesNotMatch(past, /Open positions/);
    assert.match(past, /Closed positions \(2\) · showing 1 of 2 \(--top 1\)/);
    assert.doesNotMatch(past, /#1373723/);
    const active = (await cli('positions', 'list', '--wallet-addr', WALLET, '--active')).stdout;
    assert.match(active, /Open positions \(1\)/);
    assert.doesNotMatch(active, /Closed positions/);
    const json = JSON.parse((await cli('positions', 'list', '--wallet-addr', WALLET, '--chain', 'eth,arb', '--json')).stdout);
    assert.equal(json.schemaVersion, 1);
    assert.deepEqual(json.data.active, []);
    assert.deepEqual(json.data.past.map((position: { id: string; chainId: number }) => [position.id, position.chainId]), [['5723933', 42161], ['1373723', 1]]);

    // A saved EVM wallet is read on every EVM network (--chain narrows it), whatever network it was saved for.
    assert.equal(sync('wallet', 'add', WALLET, '--chain', 'base', '--name', 'ledger').status, 0);
    assert.equal(sync('wallet', 'add', 'So11111111111111111111111111111111111111112', '--chain', 'sol', '--name', 'phantom').status, 0);
    const named = await cli('positions', 'list', '--wallet', 'LEDGER');
    assert.match(named.stdout, /Uniswap positions · ledger \(0x902e…3f00\) on all networks/);
    assert.match(named.stdout, /Open positions \(1\)/);
    assert.match(named.stdout, /Closed positions \(2\)/);
    const narrowed = await cli('positions', 'list', '--wallet', 'ledger', '--chain', 'base');
    assert.match(narrowed.stdout, /Closed positions \(0\)\n  No closed positions\./);
    // Without --wallet: the default wallet. None chosen, so the latest added (Solana) is used, which has no Uniswap positions.
    const solana = sync('positions', 'list');
    assert.equal(solana.status, 1);
    assert.match(solana.stderr, /The default wallet phantom is a Solana wallet/);
    assert.equal(sync('wallet', 'set-default', 'ledger').status, 0);
    const byDefault = await cli('positions', 'list');
    assert.match(byDefault.stderr, /Using the default wallet ledger \(0x902e…3f00\); pass --wallet to choose another/);
    assert.match(byDefault.stdout, /ledger \(0x902e…3f00\) on all networks/);
    // positions detail reads the same wallets: the default one, or --wallet.
    const detail = await cli('positions', 'detail', '1', '--offline', '--no-plot', '--data-dir', join(directory, 'cache'), '--width', '120');
    assert.match(detail.stderr, /Using the default wallet ledger/);
    assert.match(detail.stdout, /WETH\/USDC 0\.3%\s+Uniswap v3 · Base · position #999 · ledger/);
    const byId = await cli('positions', 'detail', '#5723933', '--wallet', 'ledger', '--offline', '--no-plot', '--data-dir', join(directory, 'cache'), '--width', '120');
    assert.doesNotMatch(byId.stderr, /Using the default wallet/);
    assert.match(byId.stdout, /position #5723933/);
    // --wallet all: every saved wallet, Solana skipped.
    const everything = await cli('positions', 'list', '--wallet', 'all');
    assert.match(everything.stdout, /ledger \(0x902e…3f00\) on all networks/);
    assert.match(everything.stderr, /Note: skipping phantom \(Solana\)/);
    assert.equal(requests.filter((url) => url.includes('uniswapv3')).length, 10); // One request per address and run.

    for (const [args, message] of [
      [['--wallet', 'nobody'], /No saved wallet named "nobody"/],
      [['--wallet-addr', 'not-an-address'], /--wallet-addr "not-an-address" is not a 0x address/],
      [['--top', '0'], /--top must be a positive integer/],
      [['--top', '1001'], /--top supports 1 through 1000/],
      [['--source', 'graph'], /--source "graph" is not supported\. Choose auto, revert, rpc/],
    ] as const) {
      const result = sync('positions', 'list', ...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, message);
    }
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('positions list explains when Revert is unreachable and --source revert is required', () => {
  const directory = mkdtempSync(join(tmpdir(), 'defi-tool-positions-down-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'positions', 'list', '--wallet-addr', WALLET, '--source', 'revert'], {
      env: env(directory, { DEFI_TOOL_REVERT_URL: 'http://127.0.0.1:9' }), timeout: 15_000, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not reach Revert Finance/);
    assert.match(result.stderr, /Revert Finance could not be reached for any wallet.*--source rpc/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

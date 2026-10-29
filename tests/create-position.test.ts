import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { RpcProvider } from '../src/providers/rpc.js';
import { parseAmount, parseDeadline, parseLimit, planPosition, type CreateRequest } from '../src/create-position.js';
import { sqrtRatioAtTick } from '../src/v3-math.js';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL = '0x00000000000000000000000000000000000000aa';
const MANAGER = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
const WALLET = '0x00000000000000000000000000000000000000bb';
const TICK = -198_000; // About 2,520 USDC per WETH.
const managerAbi = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function multicall(bytes[]) payable returns (bytes[])',
]);

interface Wallet { weth: bigint; usdc: bigint; eth: bigint; allowanceWeth: bigint; allowanceUsdc: bigint }

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

/** A Base node with one 0.05% WETH/USDC pool, and DefiLlama prices with a gently moving ETH price history. */
async function withFixtures(wallet: Wallet, action: (rpc: RpcProvider, pricesUrl: string, calls: Hex[]) => Promise<void>) {
  const calls: Hex[] = [];
  const word = (types: string, values: unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
  const rpc = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const request = JSON.parse(text);
      const reply = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })); };
      if (request.method === 'eth_getBalance') return reply(`0x${wallet.eth.toString(16)}`);
      if (request.method === 'eth_estimateGas') return reply('0x5208');
      if (request.method === 'eth_chainId') return reply('0x2105');
      const { to, data } = request.params[0] as { to: string; data: Hex };
      const target = to.toLowerCase();
      const is = (signature: string) => data.startsWith(toFunctionSelector(signature));
      let result: Hex;
      if (is('getPool(address,address,uint24)')) result = word('address', [BigInt(`0x${data.slice(-64)}`) === 500n ? POOL : '0x0000000000000000000000000000000000000000']);
      else if (is('slot0()')) result = word('uint160,int24,uint16,uint16,uint16,uint8,bool', [sqrtRatioAtTick(TICK), TICK, 0, 0, 0, 0, true]);
      else if (is('tickSpacing()')) result = word('int24', [10]);
      else if (is('WETH9()')) result = word('address', [WETH]);
      else if (is('symbol()')) result = word('string', [target === WETH ? 'WETH' : 'USDC']);
      else if (is('decimals()')) result = word('uint8', [target === WETH ? 18 : 6]);
      else if (is('balanceOf(address)')) {
        const owner = `0x${data.slice(-40)}`;
        result = word('uint256', [owner === POOL ? (target === WETH ? 1000n * 10n ** 18n : 2_500_000n * 10n ** 6n) : target === WETH ? wallet.weth : wallet.usdc]);
      } else if (is('allowance(address,address)')) result = word('uint256', [target === WETH ? wallet.allowanceWeth : wallet.allowanceUsdc]);
      else if (target === MANAGER) {
        calls.push(data);
        const minted = word('uint256,uint128,uint256,uint256', [77n, 1n, 1n, 1n]);
        result = is('multicall(bytes[])') ? word('bytes[]', [[minted, '0x']]) : minted;
      } else return res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown fixture call ${data.slice(0, 10)}` } }));
      reply(result);
    });
  });
  const prices = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/prices/current/')) return res.end(JSON.stringify({ coins: { [`base:${WETH}`]: { price: 2520 }, [`base:${USDC}`]: { price: 1 } } }));
    // ETH alternates ±1% a day: a daily volatility of about 1%.
    const history = Array.from({ length: 31 }, (_, day) => ({ timestamp: day * 86_400, price: 2520 * (day % 2 ? 1.01 : 1) }));
    res.end(JSON.stringify({ coins: { [`base:${WETH}`]: { prices: history }, [`base:${USDC}`]: { prices: history.map((point) => ({ ...point, price: 1 })) } } }));
  });
  const [rpcUrl, pricesUrl] = [await listen(rpc), await listen(prices)];
  try { await action(new RpcProvider({ 8453: rpcUrl }), pricesUrl, calls); } finally {
    await Promise.all([rpc, prices].map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
  }
}

const request = (pricesUrl: string, changes: Partial<CreateRequest> = {}): CreateRequest => ({
  chainId: 8453, pair: ['WETH', 'USDC'], lower: { kind: 'percent', value: -15 }, upper: { kind: 'percent', value: 10 },
  amount: { kind: 'usd', value: 100 }, wallet: WALLET, slippage: 0.005, deadlineSeconds: 1200, payWith: 'auto', approve: 'exact',
  pricesUrl, now: () => 1_800_000_000_000, ...changes,
});

test('plans an asymmetric range: ticks on the spacing, the USD amount split by the range, and exact approvals first', async () => {
  const wallet = { weth: 10n ** 18n, usdc: 1000n * 10n ** 6n, eth: 10n ** 16n, allowanceWeth: 0n, allowanceUsdc: 0n };
  await withFixtures(wallet, async (rpc, pricesUrl, calls) => {
    const plan = await planPosition(request(pricesUrl), rpc);
    assert.equal(plan.pool.address, POOL);
    assert.equal(plan.pool.feeTier, 500);
    assert.equal(plan.unit, 'USDC per WETH');
    assert.ok(Math.abs(plan.price - 2520) < 1);
    // Ticks sit on the spacing and are widened outward, so the range is at least as wide as asked.
    assert.equal(Math.abs(plan.range.tickLower % 10), 0);
    assert.equal(Math.abs(plan.range.tickUpper % 10), 0);
    assert.ok(plan.range.lowerPct <= -15 && plan.range.lowerPct > -15.1, `${plan.range.lowerPct}`);
    assert.ok(plan.range.upperPct >= 10 && plan.range.upperPct < 10.1, `${plan.range.upperPct}`);
    assert.ok(Math.abs(plan.deposit.valueUsd! - 100) < 0.01);
    assert.ok(Number(plan.deposit.min0) < Number(plan.deposit.amount0) && Number(plan.deposit.min1) < Number(plan.deposit.amount1));
    assert.deepEqual(plan.transactions.map((transaction) => transaction.description), [
      `Approve ${Number(Number(plan.deposit.amount0).toPrecision(6))} WETH for the Uniswap v3 position manager`,
      `Approve ${Number(Number(plan.deposit.amount1).toPrecision(6))} USDC for the Uniswap v3 position manager`,
      'Create the WETH/USDC 0.05% position',
    ]);
    // The mint carries the range, amounts, minimums, recipient and deadline exactly.
    const { args } = decodeFunctionData({ abi: managerAbi, data: plan.transactions[2]!.data });
    const params = args[0] as { tickLower: number; tickUpper: number; recipient: string; deadline: bigint; amount0Min: bigint; amount0Desired: bigint };
    assert.deepEqual([params.tickLower, params.tickUpper], [plan.range.tickLower, plan.range.tickUpper]);
    assert.equal(params.recipient.toLowerCase(), WALLET);
    assert.equal(params.deadline, 1_800_001_200n);
    assert.ok(params.amount0Min < params.amount0Desired);
    // The mint is not simulated before the approvals exist; the volatility check uses the price history.
    assert.equal(plan.simulation.status, 'after-approvals');
    assert.equal(calls.length, 0);
    assert.ok(plan.ready);
    assert.ok(plan.volatility && Math.abs(plan.volatility.dailyPct - 1) < 0.1, `${plan.volatility?.dailyPct}`);
    assert.ok(plan.volatility!.daysToUpper! > 50);
    assert.deepEqual(plan.warnings, []);
  });
});

test('pays the WETH side in native ETH when the wallet has no WETH, and simulates the mint', async () => {
  const wallet = { weth: 0n, usdc: 1000n * 10n ** 6n, eth: 10n ** 18n, allowanceWeth: 0n, allowanceUsdc: 10n ** 30n };
  await withFixtures(wallet, async (rpc, pricesUrl, calls) => {
    const plan = await planPosition(request(pricesUrl, { amount: { kind: 'token', token: 'usdc', value: '50' } }), rpc);
    assert.equal(plan.deposit.amount1, '50');
    assert.equal(plan.deposit.payNative, true);
    assert.equal(plan.transactions.length, 1);
    const [mint] = plan.transactions;
    assert.ok(BigInt(mint!.value) > 0n);
    assert.equal(decodeFunctionData({ abi: managerAbi, data: mint!.data }).functionName, 'multicall');
    assert.deepEqual(plan.simulation, { status: 'passed', tokenId: '77', gas: '21000' });
    assert.equal(calls.length, 1);
  });
});

test('warns about shortfalls and narrow ranges, and refuses impossible deposits', async () => {
  const wallet = { weth: 0n, usdc: 0n, eth: 0n, allowanceWeth: 0n, allowanceUsdc: 0n };
  await withFixtures(wallet, async (rpc, pricesUrl) => {
    const plan = await planPosition(request(pricesUrl, { lower: { kind: 'percent', value: -1 }, upper: { kind: 'percent', value: 1 } }), rpc);
    assert.equal(plan.ready, false);
    assert.match(plan.warnings.join('\n'), /short .* WETH/);
    assert.match(plan.warnings.join('\n'), /short .* USDC/);
    assert.match(plan.warnings.join('\n'), /typical move leaves this range in about (a day|\d+ days?)/);
    // Range entirely above the price holds only WETH, so a USDC amount cannot fund it.
    await assert.rejects(planPosition(request(pricesUrl, { lower: { kind: 'percent', value: 5 }, upper: { kind: 'percent', value: 10 }, amount: { kind: 'token', token: 'usdc', value: '10' } }), rpc), /holds only WETH/);
    await assert.rejects(planPosition(request(pricesUrl, { feeTier: 3000 }), rpc), /No 0.3% Uniswap v3 pool/);
    await assert.rejects(planPosition(request(pricesUrl, { pair: ['WETH', 'NOPE'] }), rpc), /not known on Base/);
    await assert.rejects(planPosition(request(pricesUrl, { amount: { kind: 'max' } }), rpc), /no WETH or USDC/);
  });
});

test('parses limits, amounts and deadlines', () => {
  assert.deepEqual(parseLimit('-15%', '--lower-limit'), { kind: 'percent', value: -15 });
  assert.deepEqual(parseLimit('+10%', '--upper-limit'), { kind: 'percent', value: 10 });
  assert.deepEqual(parseLimit('2,100', '--lower-limit'), { kind: 'price', value: 2100 });
  assert.throws(() => parseLimit('-100%', '--lower-limit'), /at or below zero/);
  assert.throws(() => parseLimit('-15', '--lower-limit'), /not a limit/);
  assert.deepEqual(parseAmount('100usd'), { kind: 'usd', value: 100 });
  assert.deepEqual(parseAmount('$1,000'), { kind: 'usd', value: 1000 });
  assert.deepEqual(parseAmount('0.05 WETH'), { kind: 'token', token: 'WETH', value: '0.05' });
  assert.deepEqual(parseAmount('MAX'), { kind: 'max' });
  assert.throws(() => parseAmount('lots'), /not an amount/);
  assert.equal(parseDeadline('20m'), 1200);
  assert.equal(parseDeadline('1h'), 3600);
  assert.throws(() => parseDeadline('10s'), /between 1m and 24h/);
});

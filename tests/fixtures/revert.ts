// Revert Finance positions API rows for tests. The closed position is trimmed from a real response
// (Arbitrum NFT #5723933, WETH/USDC 0.05%); the open one is made up with round numbers.
export const WALLET = '0x902ebd8f3a08731224a1c216f84f34ce5f4d3f00';
export const NOW = 1_793_260_000_000;
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const prices = (token0: number, token1: number) => ({ token0: { usd: token0 }, token1: { usd: token1 } });

export const closedArbitrum = {
  nft_id: 5723933, network: 'arbitrum', exchange: 'uniswapv3', pool: '0xc6962004f452be9203591991d15f6b388e09e8d0', owner: WALLET,
  token0: WETH_ARB, token1: USDC_ARB,
  tokens: { [WETH_ARB]: { symbol: 'WETH', decimals: 18, price: 2309.94 }, [USDC_ARB]: { symbol: 'USDC', decimals: 6, price: 0.9991 } },
  fee_tier: '500', tick_lower: -198680, tick_upper: -197800, pool_tick: -198861,
  price_lower: '2354.337027210419', price_upper: '2570.8967577483854', pool_price: '2312.118204054028',
  liquidity: '0', exited: true, in_range: false,
  current_amount0: '0.0', current_amount1: '0', underlying_value: '0E-10', uncollected_fees0: '0.0', uncollected_fees1: '0.0',
  fees_value: '2.7779', deposits_value: '75.8637', withdrawals_value: '74.6749', first_mint_ts: 1791484414,
  performance: { usd: { pnl: '-1.0641', il: '-3.8215', pool_pnl: '-1.0121' } },
  cash_flows: [
    { type: 'gas-costs', timestamp: 1791484414, amount_usd: '-0.02129266152492183000' },
    { type: 'deposits', timestamp: 1791484414, amount0: '-0.018535803505634539', amount1: '-33.078043', price: 2442.865121345465, prices: prices(2443.247161, 0.9999562604) },
    { type: 'gas-costs', timestamp: 1793221568, amount_usd: '-0.010216332463859792936830125' },
    { type: 'claimed-fees', timestamp: 1793221568, amount0: '0.000584479023964822', amount1: '1.412796', price: 2361.3252255860116, prices: prices(2361.325226, 1.0) },
    { type: 'gas-costs', timestamp: 1793258847, amount_usd: '-0.00956855566139235750' },
    { type: 'withdrawals', timestamp: 1793258847, amount0: '0.032327630145160527', amount1: '0', price: 2305.848958271908, prices: prices(2305.848958, 1.0) },
    { type: 'current-amount-state', timestamp: 1793261729, amount0: '0.0', amount1: '0' },
  ],
};

export const openBase = {
  nft_id: '999', network: 'base', pool: '0xd0b53d9277642d899df5c87a3966a349a798f224', owner: WALLET,
  token0: WETH_BASE, token1: USDC_BASE,
  tokens: { [WETH_BASE]: { symbol: 'WETH', decimals: 18, price: 2400 }, [USDC_BASE]: { symbol: 'USDC', decimals: 6, price: 1 } },
  fee_tier: '3000', tick_lower: -199000, tick_upper: -197000, pool_tick: -198000,
  price_lower: '2300', price_upper: '2500', pool_price: '2400',
  liquidity: '123456', exited: false, in_range: true,
  current_amount0: '0.01', current_amount1: '25', underlying_value: '49', uncollected_fees0: '0.0001', uncollected_fees1: '0.3',
  fees_value: '1.5', deposits_value: '49', withdrawals_value: '0', first_mint_ts: NOW / 1000 - 10 * 86_400,
  performance: { usd: { pnl: '1.4', il: '-0.2' } },
  cash_flows: [
    { type: 'deposits', timestamp: NOW / 1000 - 10 * 86_400, amount0: '-0.01', amount1: '-25', prices: prices(2400, 1) },
    { type: 'gas-costs', timestamp: NOW / 1000 - 10 * 86_400, amount_usd: '-0.1' },
    { type: 'claimed-fees', timestamp: NOW / 1000 - 86_400, amount0: '0', amount1: '1', prices: prices(2400, 1) },
  ],
};

/** The same position on Ethereum, opened and closed about 12 days earlier, for ordering and --chain tests. */
const EARLIER = 1_054_247;
export const closedEthereum = {
  ...closedArbitrum, nft_id: 1373723, network: 'mainnet', first_mint_ts: closedArbitrum.first_mint_ts - EARLIER,
  cash_flows: closedArbitrum.cash_flows.map((flow) => ({ ...flow, timestamp: flow.timestamp - EARLIER })),
};

import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, type Address } from 'viem';
import { mainnet, arbitrum, optimism, base, polygon, bsc, robinhood } from 'viem/chains';
import { isEvmChain, type EvmChainId, type LpPosition, type Pool, type Position, type Protocol } from '../types.js';
import { amountsForLiquidity, sqrtPriceX96ToPrice, tickToPrice } from '../positions-math.js';
import { V3_POSITIONS, V4_DEPLOYMENTS } from './deployments.js';

const chains = { 1: mainnet, 10: optimism, 56: bsc, 137: polygon, 4663: robinhood, 8453: base, 42161: arbitrum } as const;
const poolAbi = parseAbi([
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
]);
const positionAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function factory() view returns (address)',
]);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const collectAbi = parseAbi(['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)']);
const MAX_UINT128 = 2n ** 128n - 1n;
const v4PositionAbi = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getPoolAndPositionInfo(uint256) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
]);
const stateAbi = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']);

export class RpcProvider {
  private readonly clients = new Map<EvmChainId, ReturnType<typeof createPublicClient>>();
  constructor(private readonly rpcUrls: Partial<Record<EvmChainId, string>>) {}

  /** A viem client for the network: the configured RPC URL, or the public default from viem's chain registry. */
  client(chainId: EvmChainId): ReturnType<typeof createPublicClient> {
    const existing = this.clients.get(chainId);
    if (existing) return existing;
    const url = this.rpcUrls[chainId] ?? chains[chainId].rpcUrls.default.http[0];
    const client = createPublicClient({ transport: http(url, { timeout: 12_000, retryCount: 1 }) });
    this.clients.set(chainId, client);
    return client;
  }

  async enrichPool(pool: Pool): Promise<Pool> {
    // Public discovery already has its own data; RPC enrichment is opt-in for bulk scans. Solana pools have no EVM RPC.
    const chainId = pool.chainId;
    if (!isEvmChain(chainId) || !this.rpcUrls[chainId]) return pool;
    try {
      const client = this.client(chainId);
      if (pool.protocol === 'v4') {
        if (!/^0x[0-9a-fA-F]{64}$/.test(pool.id)) return pool;
        const slot0 = await client.readContract({ address: V4_DEPLOYMENTS[chainId].state, abi: stateAbi, functionName: 'getSlot0', args: [pool.id as `0x${string}`] });
        return { ...pool, tick: slot0[1], source: 'mixed', observedAt: new Date().toISOString() };
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(pool.id)) return pool;
      const [slot0, liquidity] = await Promise.all([
        client.readContract({ address: pool.id as Address, abi: poolAbi, functionName: 'slot0' }),
        client.readContract({ address: pool.id as Address, abi: poolAbi, functionName: 'liquidity' }),
      ]);
      return { ...pool, tick: slot0[1], liquidity: liquidity.toString(), source: 'mixed', observedAt: new Date().toISOString() };
    } catch { return pool; }
  }

  async currentTick(pool: Pool): Promise<number | undefined> {
    if (pool.tick !== undefined) return pool.tick;
    const chainId = pool.chainId;
    if (!isEvmChain(chainId)) return undefined;
    const client = this.client(chainId);
    if (pool.protocol === 'v4' && /^0x[0-9a-fA-F]{64}$/.test(pool.id)) {
      const slot = await client.readContract({ address: V4_DEPLOYMENTS[chainId].state, abi: stateAbi, functionName: 'getSlot0', args: [pool.id as `0x${string}`] });
      return slot[1];
    }
    if (pool.protocol === 'v3' && /^0x[0-9a-fA-F]{40}$/.test(pool.id)) {
      const slot = await client.readContract({ address: pool.id as Address, abi: poolAbi, functionName: 'slot0' });
      return slot[1];
    }
    return undefined;
  }

  async listPositions(wallet: string, chainId: EvmChainId, protocol: Protocol, ids?: string[]): Promise<Position[]> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid wallet address.');
    if (protocol === 'v4' && !ids?.length) throw new Error('Key-free v4 positions require --position <NFT IDs> and one --chain. V4 wallet-wide discovery needs an indexer.');
    if (ids?.some((id) => !/^\d+$/.test(id) || BigInt(id) >= 2n ** 256n)) throw new Error('Position IDs must be unsigned integers smaller than 2^256.');
    const client = this.client(chainId);
    const manager = protocol === 'v3' ? V3_POSITIONS[chainId] : V4_DEPLOYMENTS[chainId].positions;
    let tokenIds = ids ? [...new Set(ids.map(BigInt))] : undefined;
    if (!tokenIds) {
      const count = await client.readContract({ address: manager, abi: positionAbi, functionName: 'balanceOf', args: [wallet as Address] });
      if (count > 500n) throw new Error('Wallet has more than 500 NFTs. Select specific IDs with --position to bound public RPC usage.');
      tokenIds = [];
      for (let index = 0n; index < count; index += 1n) tokenIds.push(await client.readContract({ address: manager, abi: positionAbi, functionName: 'tokenOfOwnerByIndex', args: [wallet as Address, index] }));
    }
    if (!tokenIds.length) return [];
    const factory = protocol === 'v3' ? await client.readContract({ address: manager, abi: positionAbi, functionName: 'factory' }) : undefined;
    const positions: Position[] = [];
    for (const id of tokenIds) {
      const owner = await client.readContract({ address: manager, abi: positionAbi, functionName: 'ownerOf', args: [id] });
      if (owner.toLowerCase() !== wallet.toLowerCase()) throw new Error(`Position ${id} is not owned by the requested wallet on this network.`);
      if (protocol === 'v3') {
        const data = await client.readContract({ address: manager, abi: positionAbi, functionName: 'positions', args: [id] });
        if (data[7] === 0n) continue;
        const poolId = await client.readContract({ address: factory!, abi: factoryAbi, functionName: 'getPool', args: [data[2], data[3], data[4]] });
        const slot = await client.readContract({ address: poolId, abi: poolAbi, functionName: 'slot0' });
        positions.push({ id: id.toString(), wallet, chainId, protocol, poolId, lowerTick: data[5], upperTick: data[6], currentTick: slot[1], liquidity: data[7].toString(), source: 'rpc' });
      } else {
        const [key, info] = await client.readContract({ address: manager, abi: v4PositionAbi, functionName: 'getPoolAndPositionInfo', args: [id] });
        const liquidity = await client.readContract({ address: manager, abi: v4PositionAbi, functionName: 'getPositionLiquidity', args: [id] });
        if (liquidity === 0n) continue;
        const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
        const slot = await client.readContract({ address: V4_DEPLOYMENTS[chainId].state, abi: stateAbi, functionName: 'getSlot0', args: [poolId] });
        positions.push({ id: id.toString(), wallet, chainId, protocol, poolId, lowerTick: signedTick(info >> 8n), upperTick: signedTick(info >> 32n), currentTick: slot[1], liquidity: liquidity.toString(), source: 'rpc' });
      }
    }
    return positions;
  }

  /**
   * Every Uniswap v3 position NFT the wallet holds on a network, open and closed, with its current price, token
   * amounts and uncollected fees. A fallback for positions list: on-chain state has no deposit, withdrawal or
   * collected-fee history, and NFTs that were burned or transferred away are not found. Prices in USD are added by the caller.
   */
  async portfolio(wallet: string, chainId: EvmChainId): Promise<LpPosition[]> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid wallet address.');
    const client = this.client(chainId);
    const manager = V3_POSITIONS[chainId];
    const count = await client.readContract({ address: manager, abi: positionAbi, functionName: 'balanceOf', args: [wallet as Address] });
    if (count > 500n) throw new Error('Wallet has more than 500 position NFTs on this network; too many to read over public RPC.');
    if (count === 0n) return [];
    const factory = await client.readContract({ address: manager, abi: positionAbi, functionName: 'factory' });
    const tokens = new Map<string, Promise<{ symbol: string; decimals?: number }>>();
    const token = (address: Address) => {
      const key = address.toLowerCase();
      if (!tokens.has(key)) tokens.set(key, (async () => {
        // Some old tokens (e.g. MKR) return bytes32 symbols; show a short address instead of failing.
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => `${key.slice(0, 6)}…`),
          client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).then(Number).catch(() => undefined),
        ]);
        return { symbol, decimals };
      })());
      return tokens.get(key)!;
    };
    const positions: LpPosition[] = [];
    for (let index = 0n; index < count; index += 1n) {
      const id = await client.readContract({ address: manager, abi: positionAbi, functionName: 'tokenOfOwnerByIndex', args: [wallet as Address, index] });
      const data = await client.readContract({ address: manager, abi: positionAbi, functionName: 'positions', args: [id] });
      const [, , address0, address1, fee, tickLower, tickUpper, liquidity] = data;
      const [info0, info1, pool] = await Promise.all([token(address0), token(address1),
        client.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [address0, address1, fee] })]);
      const [sqrtPriceX96, tick] = await client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' });
      // Uncollected fees: what collect() would pay the owner now, simulated without sending a transaction.
      const owed = await client.simulateContract({ address: manager, abi: collectAbi, functionName: 'collect', account: wallet as Address,
        args: [{ tokenId: id, recipient: wallet as Address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] }).then(({ result }) => result).catch(() => undefined);
      const known = info0.decimals !== undefined && info1.decimals !== undefined;
      const [amount0, amount1] = known ? amountsForLiquidity(liquidity, sqrtPriceX96, tickLower, tickUpper, info0.decimals!, info1.decimals!) : [undefined, undefined];
      positions.push({
        id: id.toString(), chainId, dex: 'Uniswap', protocol: 'v3', wallet: wallet.toLowerCase(), pool: pool.toLowerCase(),
        token0: { address: address0.toLowerCase(), ...info0 }, token1: { address: address1.toLowerCase(), ...info1 }, feeTier: fee,
        tickLower, tickUpper, currentTick: tick,
        priceLower: known ? tickToPrice(tickLower, info0.decimals!, info1.decimals!) : undefined,
        priceUpper: known ? tickToPrice(tickUpper, info0.decimals!, info1.decimals!) : undefined,
        price: known ? sqrtPriceX96ToPrice(sqrtPriceX96, info0.decimals!, info1.decimals!) : undefined,
        liquidity: liquidity.toString(), active: liquidity > 0n, inRange: tick >= tickLower && tick < tickUpper,
        amount0, amount1,
        uncollectedFees0: owed && known ? Number(owed[0]) / 10 ** info0.decimals! : undefined,
        uncollectedFees1: owed && known ? Number(owed[1]) / 10 ** info1.decimals! : undefined,
        source: 'rpc', historyAvailable: false,
      });
    }
    return positions;
  }
}

function signedTick(value: bigint): number {
  const tick = Number(value & 0xffffffn);
  return tick >= 0x800000 ? tick - 0x1000000 : tick;
}

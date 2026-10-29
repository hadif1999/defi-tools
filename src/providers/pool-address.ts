import { encodeAbiParameters, encodePacked, getContractAddress, keccak256, type Address } from 'viem';
import type { EvmChainId, PoolVersion } from '../types.js';
import { V2_FACTORIES, V2_PAIR_INIT_CODE_HASH, V3_FACTORIES, V3_POOL_INIT_CODE_HASH } from './deployments.js';

const isAddress = (value: string): value is Address => /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Derive a v2 pair or v3 pool contract address from its tokens (and fee tier for v3), as the factory does.
 * v4 pools are identified by a hash that also covers tick spacing and hooks, so they cannot be derived here.
 */
export function poolAddress(chainId: EvmChainId, version: PoolVersion, tokenA: string, tokenB: string, feeTier?: number): string | undefined {
  if (!isAddress(tokenA) || !isAddress(tokenB) || tokenA.toLowerCase() === tokenB.toLowerCase()) return undefined;
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  if (version === 'v2') {
    return getContractAddress({ opcode: 'CREATE2', from: V2_FACTORIES[chainId], bytecodeHash: V2_PAIR_INIT_CODE_HASH, salt: keccak256(encodePacked(['address', 'address'], [token0, token1])) }).toLowerCase();
  }
  if (version === 'v3' && feeTier !== undefined) {
    const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [token0, token1, feeTier]));
    return getContractAddress({ opcode: 'CREATE2', from: V3_FACTORIES[chainId], bytecodeHash: V3_POOL_INIT_CODE_HASH, salt }).toLowerCase();
  }
  return undefined;
}

const STANDARD_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/**
 * The v4 pool ID a hookless pool with the standard tick spacing for its fee tier would have. A guess:
 * callers must confirm it is the intended pool (e.g. by matching TVL), since hooked pools differ.
 */
export function hooklessV4PoolId(tokenA: string, tokenB: string, feeTier: number | undefined): string | undefined {
  const tickSpacing = feeTier === undefined ? undefined : STANDARD_TICK_SPACING[feeTier];
  if (tickSpacing === undefined || !isAddress(tokenA) || !isAddress(tokenB) || tokenA.toLowerCase() === tokenB.toLowerCase()) return undefined;
  const [currency0, currency1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [currency0, currency1, feeTier!, tickSpacing, '0x0000000000000000000000000000000000000000']));
}

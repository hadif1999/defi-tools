import type { Pool, Position, Protocol } from './types.js';

export interface ProtocolAdapter {
  readonly protocol: Protocol;
  readonly positionModel: 'nft' | 'singleton';
  supportsPool(pool: Pool): boolean;
  supportsPosition(position: Position): boolean;
}

export const v3Adapter: ProtocolAdapter = {
  protocol: 'v3',
  positionModel: 'nft',
  supportsPool: (pool) => pool.protocol === 'v3',
  supportsPosition: (position) => position.protocol === 'v3',
};

export const v4Adapter: ProtocolAdapter = {
  protocol: 'v4',
  positionModel: 'singleton',
  supportsPool: (pool) => pool.protocol === 'v4',
  supportsPosition: (position) => position.protocol === 'v4',
};

export function adapterFor(protocol: Protocol): ProtocolAdapter {
  return protocol === 'v3' ? v3Adapter : v4Adapter;
}

import type { Address } from 'viem';
import type { EvmChainId } from '../types.js';

// Addresses: https://developers.uniswap.org/deployments.json (official Uniswap deployments feed).
// https://docs.uniswap.org/contracts/v4/deployments
export const V4_DEPLOYMENTS: Record<EvmChainId, { positions: Address; state: Address }> = {
  1: { positions: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', state: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227' },
  10: { positions: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017', state: '0xc18a3169788f4f75a170290584eca6395c75ecdb' },
  56: { positions: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b', state: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4' },
  137: { positions: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9', state: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a' },
  4663: { positions: '0x58daec3116aae6d93017baaea7749052e8a04fa7', state: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' },
  8453: { positions: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', state: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71' },
  42161: { positions: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', state: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990' },
};

// https://docs.uniswap.org/contracts/v3/reference/deployments
export const V3_POSITIONS: Record<EvmChainId, Address> = {
  1: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  10: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  137: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  42161: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  8453: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
  56: '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',
  4663: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
};

// Factories and pool init-code hashes used to derive pool addresses (CREATE2).
// https://docs.uniswap.org/contracts/v3/reference/deployments, https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments
export const V3_FACTORIES: Record<EvmChainId, Address> = {
  1: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  10: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  137: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  42161: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  8453: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  56: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
  4663: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
};
export const V3_POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
export const V2_FACTORIES: Record<EvmChainId, Address> = {
  1: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  10: '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf',
  137: '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C',
  8453: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  42161: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
  56: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
  4663: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
};
export const V2_PAIR_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';

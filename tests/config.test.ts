import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChains, parsePositiveInt } from '../src/config.js';

test('validates positive integer CLI options', () => {
  assert.equal(parsePositiveInt('25', '--limit'), 25);
  assert.throws(() => parsePositiveInt('0', '--limit'), /positive integer/);
  assert.throws(() => parsePositiveInt('nope', '--limit'), /positive integer/);
});

test('accepts readable chain names, aliases, and legacy IDs without duplicate scans', () => {
  assert.deepEqual(parseChains('ETH, arbitrum, optimism, polygon, base'), [1, 42161, 10, 137, 8453]);
  assert.deepEqual(parseChains('ethereum,arb,op,matic'), [1, 42161, 10, 137]);
  assert.deepEqual(parseChains('1,eth,42161,arb'), [1, 42161]);
  assert.deepEqual(parseChains('all'), [1, 10, 56, 137, 501, 4663, 8453, 42161]);
  assert.deepEqual(parseChains('Solana,SOL,501'), [501]);
  for (const name of ['sol', 'SOL', 'SOLA', 'Solan', 'SOLANA', 'solana']) assert.deepEqual(parseChains(name), [501]);
  assert.deepEqual(parseChains('ethe,arbit,optim,poly,bas,robin,binan,bnb-ch'), [1, 42161, 10, 137, 8453, 4663, 56]);
  assert.equal(parseChains('all,solana')?.length, 8);
  assert.deepEqual(parseChains('BSC,bnb,binance,Robinhood,rh,robinhood-chain,4663'), [56, 4663]);
  assert.equal(parseChains(undefined), undefined);
});

test('rejects unsupported and empty chain selections with actionable guidance', () => {
  assert.throws(() => parseChains('fantom'), /not supported\. Choose eth, op, bnb, polygon, solana, robinhood, base, arb, or all/);
  for (const input of ['', ' ', 'eth,', ',base', 'so', '845', 'solanax']) {
    assert.throws(() => parseChains(input));
  }
});

test('option values ignore letter case', async () => {
  const { parseChains, parseChoice, parsePoolSorts } = await import('../src/config.js');
  assert.deepEqual(parseChains('ETH,Arb,BASE'), [1, 42161, 8453]);
  assert.equal(parseChains('ALL')?.length, 8);
  assert.equal(parseChoice('V3', ['all', 'v2', 'v3', 'v4'], '--protocol'), 'v3');
  assert.throws(() => parseChoice('v5', ['v3', 'v4'], '--protocol'), /--protocol "v5" is not supported. Choose v3, v4/);
  assert.deepEqual(parsePoolSorts('TvL, APR,tvl'), ['tvl', 'apr']);
  assert.deepEqual(parsePoolSorts('Vol-TVL'), ['vol-tvl']);
  for (const bad of ['fees', 'tvl,', '']) assert.throws(() => parsePoolSorts(bad), /--sort .* is not a sort key/);
});

test('protocol lists accept several versions in any case', async () => {
  const { parsePoolVersions } = await import('../src/config.js');
  assert.deepEqual(parsePoolVersions('v3,V2'), ['v2', 'v3']);
  assert.deepEqual(parsePoolVersions('ALL'), ['v2', 'v3', 'v4', 'clmm', 'amm']);
  assert.deepEqual(parsePoolVersions('AMM,Clmm'), ['clmm', 'amm']);
  assert.deepEqual(parsePoolVersions('v4, v4'), ['v4']);
  assert.deepEqual(parsePoolVersions('all,V2'), ['v2', 'v3', 'v4', 'clmm', 'amm']);
  for (const bad of ['v5', 'v3,', 'all,']) assert.throws(() => parsePoolVersions(bad), /--protocol/);
});

import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseChains, parseWallets, saveConfig } from './config.js';
import { CHAINS, isEvmChain, type AppConfig } from './types.js';

export interface SetupOptions {
  apiKey?: string;
  apiUrl: string;
  database: string;
  wallet?: string;
  wallets?: string;
  chain?: string;
  force?: boolean;
}

export async function runSetup(options: SetupOptions, path: string): Promise<void> {
  try {
    await access(path);
    if (!options.force) throw new Error(`Configuration already exists at ${path}. Edit it, or run defi-tool init --force to replace it.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const rl = input.isTTY ? createInterface({ input, output, terminal: true }) : undefined;
  try {
    // Default to the original networks; bnb and robinhood can be added explicitly.
    const defaults = 'eth,arb,op,base,polygon';
    const chains = parseChains(options.chain ?? (rl ? (await rl.question(`Chains (${Object.values(CHAINS).map((chain) => chain.slug).join(', ')}, or all) [${defaults}]: `)) || defaults : defaults))!;
    const wallets = parseWallets(options.wallet ?? options.wallets ?? (rl ? await rl.question('Wallet address(es), separated by commas [skip]: ') : ''));
    const apiKey = options.apiKey ?? process.env.UNISWAP_API_KEY;
    const rpcUrls: AppConfig['rpcUrls'] = {};
    if (rl) for (const chainId of chains.filter(isEvmChain)) {
      const chain = CHAINS[chainId];
      const rpc = (await rl.question(`${chain.name} RPC URL [public default; or set RPC_URL_${chain.slug.toUpperCase()}]: `)).trim();
      if (rpc) rpcUrls[chainId] = rpc;
    }
    const config: AppConfig = { apiUrl: options.apiUrl, apiKey: apiKey || undefined, rpcUrls, chains, wallets, databasePath: options.database, saturationThresholdPct: 0.1, dataTtlSeconds: 60 };
    await saveConfig(config, path, Boolean(options.force));
    console.log(`Configuration saved to ${path}`);
    console.log(`Chains: ${chains.map((id) => CHAINS[id].name).join(', ')}. Wallets: ${wallets.length}.`);
    console.log('Next: defi-tool pools rank --top 10');
    console.log('Check positions: defi-tool positions list');
    console.log('No API key needed. Public RPC defaults are included; custom RPC URLs are optional.');
  } finally { rl?.close(); }
}
